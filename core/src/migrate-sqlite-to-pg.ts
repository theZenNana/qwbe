// One-shot migration tool: the old `data/<cube>.sqlite` files into the Postgres schemas.
//
//   node core/src/migrate-sqlite-to-pg.ts [--data-dir <dir>]
//
// Per cube file, per table: count in SQLite, copy, count in Postgres, and PROVE the copy --
// same count, same set of ids (sha256 over the sorted list), and the body of 20 sampled rows
// equal after JSON canonicalisation. The one honest caveat, stated here and not hidden: the
// column is `jsonb`, which normalises whitespace and key order, so "byte for byte" means
// byte-for-byte equal AFTER both sides are parsed and re-serialised with sorted keys. A
// semantic difference (a changed value, a lost field) still fails; a formatting difference
// does not, because jsonb threw the formatting away, not the migration.
//
// The FIRST row that fails to convert stops the whole migration and is reported by id --
// never skipped silently. Nothing is deleted: after the checks pass the old file is renamed
// to `<name>.sqlite.migrated-<YYYYMMDD>` (companions too), so pointing the kernel back at
// SQLite is a rename in the other direction.

import { createHash } from "node:crypto"
import { existsSync, readdirSync, renameSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import pg from "pg"

import { closeAll, initStore } from "./pg/db.ts"
import { ensureCubeSchema, ensureTable, q, schemaName } from "./pg/setup.ts"

const argDataDir = (): string => {
  const i = process.argv.indexOf("--data-dir")
  return i > -1
    ? (process.argv[i + 1] as string)
    : (process.env.QWBE_DATA_DIR ?? join(import.meta.dirname, "..", "..", "..", "data"))
}

const admin = (): pg.Client => new pg.Client({ connectionString: process.env.QWBE_DATABASE_URL })

const canonical = (body: string): string => {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, val]) => [k, sorted(val)]),
          )
        : v
  return JSON.stringify(sorted(JSON.parse(body)))
}

const sha256 = (values: ReadonlyArray<string>): string =>
  createHash("sha256")
    .update([...values].sort().join("\n"))
    .digest("hex")

class RowFailedError extends Error {
  readonly table: string
  readonly id: string
  constructor(table: string, id: string, cause: string) {
    super(`Table "${table}", row "${id}": ${cause}`)
    this.name = "RowFailedError"
    this.table = table
    this.id = id
  }
}

export const migrateFile = async (
  pgClient: pg.Client,
  sqliteFile: string,
): Promise<{ cube: string; tables: number; rows: number }> => {
  const base = sqliteFile
    .split("/")
    .pop()!
    .replace(/\.sqlite$/, "")
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
    for (const r of old) {
      try {
        const body = canonical(r.body) // parse here: a row that is not JSON stops the migration
        await pgClient.query(
          `INSERT INTO ${q(schema)}.${q(table)} (id, type, created_at, deleted, version, body)
           VALUES ($1, $2, $3::timestamptz, $4, 1, $5::jsonb)
           ON CONFLICT (id) DO NOTHING`,
          [r.id, r.type, r.createdAt, r.deleted === 1, body],
        )
      } catch (e) {
        throw new RowFailedError(table, r.id, (e as Error).message)
      }
    }
    rows += old.length

    // --- the proof ---
    const count = await pgClient.query(`SELECT COUNT(*)::int AS c FROM ${q(schema)}.${q(table)}`)
    if ((count.rows[0] as unknown as { c: number }).c !== old.length) {
      throw new RowFailedError(table, "*", `count mismatch: sqlite ${old.length}, postgres ${count.rowCount}`)
    }
    const newIds = await pgClient.query(`SELECT id FROM ${q(schema)}.${q(table)}`)
    const oldHash = sha256(old.map((r) => r.id))
    const newHash = sha256(newIds.rows.map((r) => String((r as { id: string }).id)))
    if (oldHash !== newHash) throw new RowFailedError(table, "*", "sorted-id checksum mismatch")
    const sample = old.slice(0, 20)
    for (const r of sample) {
      const got = await pgClient.query(`SELECT body::text AS body FROM ${q(schema)}.${q(table)} WHERE id = $1`, [r.id])
      const newBody = String((got.rows[0] as unknown as { body: string }).body)
      if (canonical(newBody) !== canonical(r.body)) {
        throw new RowFailedError(table, r.id, "body differs after canonicalisation")
      }
    }
  }
  sqlite.close()
  return { cube, tables: tables.length, rows }
}

const stamp = (): string => new Date().toISOString().slice(0, 10).replace(/-/g, "")

export const renameMigrated = (sqliteFile: string): string => {
  const to = `${sqliteFile}.migrated-${stamp()}`
  renameSync(sqliteFile, to)
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${sqliteFile}${suffix}`)) renameSync(`${sqliteFile}${suffix}`, `${to}${suffix}`)
  }
  return to
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
