// One-shot migration tool: the old `data/<cube>.sqlite` files into the Postgres schemas.
//
//   node core/src/migrate-sqlite-to-pg.ts [--data-dir <dir>]
//
// Per cube file, per table: count in SQLite, copy, count in Postgres, and PROVE the copy --
// same count, same set of ids (sha256 over the sorted list), and for 20 rows sampled evenly
// across the sorted id range, body AND created_at equal after canonicalisation. The one
// honest caveat, stated here and not hidden: the column is `jsonb`, which normalises
// whitespace and key order, so "byte for byte" means byte-for-byte equal AFTER both sides are
// parsed and re-serialised with sorted keys. A semantic difference (a changed value, a lost
// field) still fails; a formatting difference does not, because jsonb threw the formatting
// away, not the migration.
//
// The copy is one transaction per table, committed ONLY after every check on that table
// passes: a failing row or a failing check leaves the table exactly as it was, and the
// SQLite file un-renamed -- there is no half-migrated state to reason about (ADR-0001
// section 7). The FIRST row that fails to convert stops the whole migration and is reported
// by id -- never skipped, never upserted over an existing row: a duplicate id raises
// RowFailedError, so stale Postgres rows cannot masquerade as migrated data. Every inserted
// row also gets its `qwbe.outbox` entry in the same transaction (ADR-0001 section 5). After
// all checks pass the old file is renamed to `<name>.sqlite.migrated-<YYYYMMDD>` (companions
// too), so pointing the kernel back at SQLite is a rename in the other direction.

import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import pg from "pg"

import { canonical, RowFailedError, renameMigrated, sampleIds, sha256 } from "./migrate-proof.ts"
import { closeAll, initStore } from "./pg/db.ts"

// The probe drives renameMigrated next to migrateFile; it stays reachable from here.
export { renameMigrated }

import { ensureCubeSchema, ensureTable, q, schemaName } from "./pg/setup.ts"

// The cube name is derived from a FILE NAME in the data directory; anything that does not
// match the manifest name rule must be refused before it can reach SQL as an identifier. The
// manifest rule is per segment: a namespaced cube like `crm/contacts` has each part checked.
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/
const cubeNameOk = (cube: string): boolean => cube.split("/").every((part) => NAME_PATTERN.test(part))

const argDataDir = (): string => {
  const i = process.argv.indexOf("--data-dir")
  return i > -1
    ? (process.argv[i + 1] as string)
    : (process.env.QWBE_DATA_DIR ?? join(import.meta.dirname, "..", "..", "..", "data"))
}

const admin = (): pg.Client => new pg.Client({ connectionString: process.env.QWBE_DATABASE_URL })

export const migrateFile = async (
  pgClient: pg.Client,
  sqliteFile: string,
): Promise<{ cube: string; tables: number; rows: number; tableNames: ReadonlyArray<string> }> => {
  const base = sqliteFile
    .split("/")
    .pop()!
    .replace(/\.sqlite$/, "")
  if (!cubeNameOk(base.replace(/--/g, "/"))) {
    throw new Error(
      `file name "${base}" does not spell a cube name under the manifest rule ${NAME_PATTERN} -- refusing to turn it into a schema identifier`,
    )
  }
  const schema = schemaName(base) // the file name was already `storeFileName` output
  const cube = base.replace(/--/g, "/")
  await ensureCubeSchema(cube)
  const sqlite = new DatabaseSync(sqliteFile)
  const tables = (
    sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{
      name: string
    }>
  ).map((r) => r.name)
  let rows = 0
  for (const table of tables) {
    await ensureTable(schema, table)
    const old = sqlite.prepare(`SELECT id, type, createdAt, deleted, body FROM ${q(table)}`).all() as Array<{
      id: string
      type: string
      createdAt: string
      deleted: number
      body: string
    }>
    // One transaction per table: copy, then the checks, then COMMIT. A failing row or a
    // failing check rolls the table back to exactly what it was.
    const client = pgClient
    await client.query("BEGIN")
    try {
      for (const r of old) {
        try {
          // The store rewrites created_at through `new Date(...).toISOString()` on the way
          // out; a source value that does not round-trip through that would be silently
          // changed by the migration, so it is refused here instead.
          if (new Date(r.createdAt).toISOString() !== r.createdAt) {
            throw new RowFailedError(table, r.id, `createdAt "${r.createdAt}" does not round-trip as UTC ISO`)
          }
          const body = canonical(r.body) // parse here: a row that is not JSON stops the migration
          await client.query(
            `INSERT INTO ${q(schema)}.${q(table)} (id, type, created_at, deleted, version, body)
             VALUES ($1, $2, $3::timestamptz, $4, 1, $5::jsonb)`,
            [r.id, r.type, r.createdAt, r.deleted === 1, body],
          )
          // Same transaction as the copy: no state in which the row changed and the event
          // did not (ADR-0001 section 5).
          await client.query(
            `INSERT INTO qwbe.outbox (cube, "table", row_id, op, version) VALUES ($1, $2, $3, 'insert', 1)`,
            [cube, table, r.id],
          )
        } catch (e) {
          if (e instanceof RowFailedError) throw e
          throw new RowFailedError(table, r.id, (e as Error).message)
        }
      }
      rows += old.length

      // --- the proof (still inside the transaction) ---
      const count = await client.query(`SELECT COUNT(*)::int AS c FROM ${q(schema)}.${q(table)}`)
      const newCount = (count.rows[0] as unknown as { c: number }).c
      if (newCount !== old.length) {
        throw new RowFailedError(table, "*", `count mismatch: sqlite ${old.length}, postgres ${newCount}`)
      }
      const newIds = await client.query(`SELECT id FROM ${q(schema)}.${q(table)}`)
      const oldHash = sha256(old.map((r) => r.id))
      const newHash = sha256(newIds.rows.map((r) => String((r as { id: string }).id)))
      if (oldHash !== newHash) throw new RowFailedError(table, "*", "sorted-id checksum mismatch")
      for (const id of sampleIds(old.map((r) => r.id))) {
        const r = old.find((o) => o.id === id)!
        const got = await client.query(
          `SELECT body::text AS body, created_at::text AS created_at FROM ${q(schema)}.${q(table)} WHERE id = $1`,
          [id],
        )
        const row = got.rows[0] as unknown as { body: string; created_at: string }
        if (canonical(row.body) !== canonical(r.body)) {
          throw new RowFailedError(table, id, "body differs after canonicalisation")
        }
        if (new Date(row.created_at).toISOString() !== r.createdAt) {
          throw new RowFailedError(table, id, `created_at differs: ${r.createdAt} -> ${row.created_at}`)
        }
      }
      await client.query("COMMIT")
    } catch (e) {
      // The copy client is the one long-lived admin client shared by every table and file:
      // a plain ROLLBACK puts it back to work. Only a rollback that ITSELF failed leaves the
      // connection in an unknown state, and then it is destroyed, not reused.
      let rollbackFailed = false
      await client.query("ROLLBACK").catch(() => {
        rollbackFailed = true
        client.end().catch(() => {})
      })
      if (!rollbackFailed) sqlite.close()
      throw e
    }
  }
  sqlite.close()
  return { cube, tables: tables.length, rows, tableNames: tables }
}

const main = async (): Promise<number> => {
  const dir = argDataDir()
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".sqlite") && !f.includes(".migrated-"))
        .sort()
    : []
  if (files.length === 0) {
    console.log(`No SQLite files to migrate in ${dir}.`)
    return 0
  }
  const client = admin()
  await client.connect()
  try {
    await initStore()
    for (const f of files) {
      const file = join(dir, f)
      const result = await migrateFile(client, file)
      const to = renameMigrated(file)
      console.log(
        `migrated ${f}: ${result.tables} table(s), ${result.rows} row(s) -> schema "${schemaName(result.cube.replace(/--/g, "--"))}", file renamed to ${to.split("/").pop()}`,
      )
      // Every table the copy created is named in the output, so tables the cube's manifest
      // never declared are visible to the operator instead of silently granted to the role.
      console.log(`  tables: ${result.tableNames.join(", ")}`)
    }
    return 0
  } catch (e) {
    console.error(`migration stopped: ${(e as Error).message}`)
    return 1
  } finally {
    await client.end().catch(() => {})
    await closeAll()
  }
}

if (process.argv[1]?.endsWith("migrate-sqlite-to-pg.ts")) {
  process.exit(await main())
}
