// One SQLite database file PER CUBE. This is ADR-0003 ("database per module, compose don't
// join") taken all the way down, and it is what makes the isolation physical rather than
// polite.
//
// The previous iteration had one shared JSON store with a flat namespace. Nothing in the type
// stopped cube `notes` from asking for the `accounts` table; only a regex caught it, and only
// when the table name was a literal -- `store.all(computedName)` walked straight through.
//
//     FORBIDDEN = it exists, but someone tells you off afterwards   (regex over source)
//     IMPOSSIBLE = there is no path, however hard you try           (no handle to open)
//
// Here the kernel reads `manifest.tables` and hands each cube a store bound to exactly those.
// A different cube's data is not in a table this connection can see: it is in another FILE,
// and this store never opens it. Asking for a foreign table throws, loudly and by name.
//
// HONEST LIMIT -- this is LINT, NOT A SANDBOX.
//
// An adversarial review demonstrated the hole rather than describing it: a cube can write
// `import { storeFor } from "../../kernel/store.ts"` and build itself a store for someone
// else's tables, or skip that and open the file directly with `new DatabaseSync(...)`, since
// `node:sqlite` and `node:fs` are ordinary imports and the data directory is in the
// environment. It ran, it read the admin password hash, and `depcruise` reported no violations.
//
// `.dependency-cruiser.cjs` now forbids both routes, so the honest claim is: a careless cube
// cannot reach another's data by accident, and a deliberate one is caught by the boundary
// check rather than by the runtime. Inside one process under one uid, that is the whole of
// what is achievable -- a real barrier means a separate process or file permissions per cube.
// Saying "impossible" here would have been a lie, and lies of that kind are exactly what this
// prototype is meant to avoid.
//
// Uses `node:sqlite`, built into Node -- no native dependency to build, and real SQL. Which
// means paging is real too: LIMIT/OFFSET plus COUNT, not a slice taken in memory.

import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { type CubeStore, storeFileName } from "./manifest.ts"
import type { Page, PageRequest } from "./pagination.ts"

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = process.env.QWBE_DATA_DIR ?? join(here, "..", "..", "..", "data")

/** One connection per cube, opened once. */
const connections = new Map<string, DatabaseSync>()

const connect = (cube: string): DatabaseSync => {
  const existing = connections.get(cube)
  if (existing) return existing
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  const db = new DatabaseSync(join(dataDir, storeFileName(cube)))
  db.exec("PRAGMA journal_mode = WAL")
  connections.set(cube, db)
  return db
}

/** Close everything. Used by the probes so a run leaves no file handles behind. */
export const closeAll = (): void => {
  for (const db of connections.values()) db.close()
  connections.clear()
}

/**
 * Every row carries the same four columns; the rest is the cube's own business.
 *
 * Values are stored as a JSON blob rather than typed columns. That is a prototype shortcut and
 * it is the reason `sortBy` and `where` below use `json_extract`. It keeps a cube from having
 * to write migrations before it can exist -- when this becomes real, the blob becomes columns
 * and only this file changes.
 */
const ensureTable = (db: DatabaseSync, table: string): void => {
  db.exec(
    `CREATE TABLE IF NOT EXISTS "${table}" (
       id TEXT PRIMARY KEY,
       type TEXT NOT NULL,
       createdAt TEXT NOT NULL,
       deleted INTEGER NOT NULL DEFAULT 0,
       body TEXT NOT NULL
     )`,
  )
}

const decode = (row: Record<string, unknown>): Record<string, unknown> => ({
  id: row.id,
  type: row.type,
  createdAt: row.createdAt,
  deleted: row.deleted === 1,
  ...(JSON.parse(String(row.body)) as Record<string, unknown>),
})

/**
 * Ids are random, not sequential. That is a correction, and the bug it fixes is worth keeping
 * written down.
 *
 * The first version used a module-level counter starting at 0. It was shared across every cube
 * (one sequence for all files, not one per table) and it reset on every restart. Reproduced by
 * an adversarial review and confirmed here: restart the server three times and login dies
 * permanently --
 *
 *     restart 0  login 200
 *     restart 1  login 200
 *     restart 2  login 500   UNIQUE constraint failed: sessions.id
 *
 * because `newId("ses")` handed out `ses-0001` again over a row that already existed. Nothing
 * repaired itself; every later start hit the same id. The shared sequence also explains why the
 * first note in a fresh database was `note-0004` -- the counter had already spent three ids on
 * accounts and sessions.
 *
 * Random removes the state that caused it. 8 hex characters is 4 billion per prefix, which is
 * far past what a prototype needs, and collisions would surface as the same UNIQUE error rather
 * than silent corruption.
 */
const newId = (prefix: string) => `${prefix}-${randomBytes(4).toString("hex")}`

/**
 * A cube asked for a table that is not its own.
 *
 * Throws rather than returning empty. A silent `[]` would look like "no data", the cube would
 * be written on a false premise, and the bug would surface months later, far from its cause.
 */
export class ForeignTableError extends Error {
  constructor(cube: string, table: string, own: ReadonlyArray<string>) {
    super(
      `Cube "${cube}" asked for table "${table}", which it does not own. ` +
        `It owns: [${own.join(", ")}]. ` +
        `Another cube's data is reached through the registry (search / summary), never through ` +
        `the store. If you genuinely need this table, declare it in your manifest -- but then it ` +
        `is yours, and nobody else may own it.`,
    )
    this.name = "ForeignTableError"
  }
}

/** Only these column names may be interpolated into SQL. Everything else is a bound parameter. */
const META_COLUMNS = new Set(["id", "type", "createdAt", "deleted"])

/**
 * The factory. The kernel calls it once per mounted cube, with that cube's declared tables.
 *
 * A cube has no way to call this with different arguments: it receives the finished store
 * through `create({ store, ... })` and never imports this file.
 */
export const storeFor = (
  cube: string,
  tables: ReadonlyArray<string>,
  /**
   * Fields this cube permits sorting by. Anything else is ignored and the default order is used.
   *
   * Sorting reads the stored row, not the response, so without a list a caller could order by a
   * column that never leaves the cube. Demonstrated: `GET /account?sortBy=passwordHash` returned
   * 200 as an ordinary reader -- closing the summary leak did not fix it, because ordering never
   * went through the summary. That is an oracle on a value the caller cannot see.
   *
   * Ignoring rather than rejecting is deliberate: the permitted set is published in the
   * catalogue, so a client can know in advance what it may sort by, and refusing would itself
   * answer "does this field exist" for anything not on the list.
   */
  sortable: ReadonlyArray<string> = [],
): CubeStore => {
  const allowed = new Set(tables)
  const sortableFields = new Set(sortable)
  const db = tables.length > 0 ? connect(cube) : null

  const check = (table: string): DatabaseSync => {
    if (!allowed.has(table) || !db) throw new ForeignTableError(cube, table, tables)
    ensureTable(db, table)
    return db
  }

  /** `sortBy` and `where` may name a JSON field, so they cannot be bound parameters.
   *  Meta columns are used directly; anything else goes through `json_extract` with the
   *  field name bound -- so a field name can never become SQL. */
  const orderClause = (sortBy: string | undefined, descending: boolean) => {
    const dir = descending ? "DESC" : "ASC"
    const fallback = { sql: `ORDER BY createdAt ${dir}`, params: [] as Array<string>, applied: "createdAt" }
    if (!sortBy) return fallback
    if (META_COLUMNS.has(sortBy)) {
      return { sql: `ORDER BY "${sortBy}" ${dir}`, params: [] as Array<string>, applied: sortBy }
    }
    // Not on the cube's published list -> default order, and the response says so via `sortedBy`,
    // so the caller can see the request was not honoured instead of being quietly misled.
    if (!sortableFields.has(sortBy)) return fallback
    return { sql: `ORDER BY json_extract(body, ?) ${dir}`, params: [`$.${sortBy}`], applied: sortBy }
  }

  const whereClause = (where?: { field: string; value: string }) => {
    if (!where) return { sql: "", params: [] as Array<string> }
    if (META_COLUMNS.has(where.field)) return { sql: `AND "${where.field}" = ?`, params: [where.value] }
    return { sql: `AND json_extract(body, ?) = ?`, params: [`$.${where.field}`, where.value] }
  }

  return {
    all: <A>(table: string) =>
      Effect.sync(() => {
        const d = check(table)
        return d
          .prepare(`SELECT * FROM "${table}" WHERE deleted = 0 ORDER BY createdAt ASC`)
          .all()
          .map((r) => decode(r as Record<string, unknown>)) as ReadonlyArray<A>
      }),

    page: <A>(table: string, page: PageRequest, where?: { field: string; value: string }) =>
      Effect.sync((): Page<A> => {
        const d = check(table)
        const w = whereClause(where)
        const o = orderClause(page.sortBy, page.descending ?? false)

        // COUNT and the page come from the same predicate, so `total` can never disagree with
        // what the rows show. This is what the frontend needs to render "1-10 of 400" without
        // fetching 400 rows.
        const total = (
          d.prepare(`SELECT COUNT(*) AS c FROM "${table}" WHERE deleted = 0 ${w.sql}`).get(...w.params) as {
            c: number
          }
        ).c

        const rows = d
          .prepare(`SELECT * FROM "${table}" WHERE deleted = 0 ${w.sql} ${o.sql} LIMIT ? OFFSET ?`)
          .all(...w.params, ...o.params, page.limit, page.offset)
          .map((r) => decode(r as Record<string, unknown>)) as ReadonlyArray<A>

        return { rows, total, offset: page.offset, limit: page.limit, sortedBy: o.applied }
      }),

    byId: <A>(table: string, id: string) =>
      Effect.sync(() => {
        const d = check(table)
        const r = d.prepare(`SELECT * FROM "${table}" WHERE id = ? AND deleted = 0`).get(id)
        return r ? (decode(r as Record<string, unknown>) as A) : undefined
      }),

    insert: (table: string, entityType: string, prefix: string, values: Record<string, unknown>) =>
      Effect.sync(() => {
        const d = check(table)
        const row = {
          id: newId(prefix),
          type: entityType,
          createdAt: new Date().toISOString(),
          deleted: false,
          ...values,
        }
        const { id, type, createdAt, deleted, ...body } = row
        d.prepare(`INSERT INTO "${table}" (id, type, createdAt, deleted, body) VALUES (?, ?, ?, ?, ?)`).run(
          id,
          type,
          createdAt,
          deleted ? 1 : 0,
          JSON.stringify(body),
        )
        return row
      }),

    update: (table: string, id: string, patch: Record<string, unknown>) =>
      Effect.sync(() => {
        const d = check(table)
        const current = d.prepare(`SELECT * FROM "${table}" WHERE id = ?`).get(id)
        if (!current) return undefined
        const merged = { ...decode(current as Record<string, unknown>), ...patch }
        const { id: _i, type, createdAt, deleted, ...body } = merged
        d.prepare(`UPDATE "${table}" SET type = ?, createdAt = ?, deleted = ?, body = ? WHERE id = ?`).run(
          String(type),
          String(createdAt),
          deleted ? 1 : 0,
          JSON.stringify(body),
          id,
        )
        return merged
      }),

    count: (table: string) =>
      Effect.sync(() => {
        const d = check(table)
        return (d.prepare(`SELECT COUNT(*) AS c FROM "${table}" WHERE deleted = 0`).get() as { c: number }).c
      }),
  }
}

/**
 * Two cubes cannot own the same table.
 *
 * Without this check, `notes` could declare `tables: ["accounts"]` and walk around the whole
 * mechanism -- legally, with a valid manifest. That is exactly the shape of failure worth
 * guarding against: the loophole is legal, so nobody reads it as a problem.
 *
 * Note that with a file per cube the collision is only a naming one -- but a shared name is
 * how the confusion starts, so it is refused anyway.
 */
export class DuplicateTableError extends Error {
  constructor(table: string, cubes: ReadonlyArray<string>) {
    super(
      `Table "${table}" is declared by more than one cube: ${cubes.join(", ")}. ` +
        `A table has exactly one owner. Whoever needs the data asks through the registry.`,
    )
    this.name = "DuplicateTableError"
  }
}

export const checkUniqueTables = (
  cubes: ReadonlyArray<{ readonly name: string; readonly tables: ReadonlyArray<string> }>,
): void => {
  const owners = new Map<string, Array<string>>()
  for (const c of cubes) {
    for (const t of c.tables) {
      const list = owners.get(t) ?? []
      list.push(c.name)
      owners.set(t, list)
    }
  }
  for (const [table, list] of owners) {
    if (list.length > 1) throw new DuplicateTableError(table, list)
  }
}
