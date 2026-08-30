// The CubeStore implementation over Postgres. Six operations, same signatures, error channel
// `never` -- the cubes were written against the SQLite store and NONE of them changes now. A
// driver failure is a defect, exactly as an unexpected SQLite error was: it escapes the Effect
// as a die, not as a failure a cube could "handle".
//
// Two invariants carry over from the old file and are restated here because they are the
// reason this module is shaped the way it is:
//
//   1. A cube asks for a table its manifest did not declare -> ForeignTableError, thrown, not
//      an empty array. The check runs BEFORE any SQL is built, so a computed table name cannot
//      reach the engine.
//   2. Only declared meta columns are interpolated into SQL. Everything else -- field names in
//      `sortBy` and `where` -- is a bound parameter (`body ->> $n`), so a field name can never
//      become SQL.
//
// Every operation, read or write, is one transaction that begins with `SET LOCAL ROLE` to the
// cube's role. That transaction is also where isolation lives: Postgres refuses anything the
// role was not granted, and `SET LOCAL` ends with the transaction, so nothing leaks between
// operations on a pooled connection.

import { randomBytes } from "node:crypto"
import { Effect } from "effect"
import type { CubeStore } from "../manifest.ts"
import type { Page, PageRequest } from "../pagination.ts"
import { getPool, type Pool } from "./db.ts"
import { ForeignTableError } from "./errors.ts"
import { ensureCubeSchema, ensureTable, q, roleName, schemaName } from "./setup.ts"

export { ForeignTableError } from "./errors.ts"

/** Ids are random, not sequential -- see the comment this replaces from the SQLite store. */
const newId = (prefix: string) => `${prefix}-${randomBytes(4).toString("hex")}`

const decode = (row: Record<string, unknown>): Record<string, unknown> => ({
  id: row.id,
  type: row.type,
  createdAt: new Date(row.created_at as string).toISOString(),
  deleted: row.deleted === true,
  ...(row.body as Record<string, unknown>),
})

/** Only these may be interpolated into SQL. Everything else is a bound parameter. */
const META_COLUMNS = new Set(["id", "type", "createdAt", "deleted"])

const outboxInsert = (cube: string, table: string, id: string, op: string, version: number) => ({
  text: `INSERT INTO qwbe.outbox (cube, "table", row_id, op, version) VALUES ($1, $2, $3, $4, $5)`,
  values: [cube, table, id, op, version],
})

/**
 * One client, one transaction, the cube's role. Everything the store does goes through here,
 * so "every operation runs under the cube's role inside a transaction" is enforced in exactly
 * one place rather than remembered in six.
 */
/**
 * Exported for the transaction test: the rollback guarantee is exactly this function's
 * catch branch, and the test drives it directly rather than duplicating its SQL.
 */
export const withRole = async <T>(cube: string, fn: (client: Pool) => Promise<T>): Promise<T> => {
  const schema = await ensureCubeSchema(cube)
  const p = getPool()
  const client = await p.connect()
  try {
    await client.query("BEGIN")
    await client.query(`SET LOCAL ROLE ${q(roleName(schema))}`)
    const result = await fn(client as unknown as Pool)
    await client.query("COMMIT")
    return result
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

export const storeFor = (
  cube: string,
  tables: ReadonlyArray<string>,
  /** Fields this cube permits sorting by. Anything else is ignored; the response says so. */
  sortable: ReadonlyArray<string> = [],
): CubeStore => {
  const allowed = new Set(tables)
  const sortableFields = new Set(sortable)

  const check = (table: string): string => {
    if (!allowed.has(table)) throw new ForeignTableError(cube, table, tables)
    return table
  }

  /** Prepared together with the WHERE clause so COUNT and the page always share a predicate. */
  const orderClause = (sortBy: string | undefined, descending: boolean) => {
    const dir = descending ? "DESC" : "ASC"
    const fallback = { sql: `ORDER BY created_at ${dir}`, params: [] as Array<string>, applied: "createdAt" }
    if (!sortBy) return fallback
    if (META_COLUMNS.has(sortBy)) {
      const column = sortBy === "createdAt" ? "created_at" : sortBy
      return { sql: `ORDER BY ${q(column)} ${dir}`, params: [] as Array<string>, applied: sortBy }
    }
    if (!sortableFields.has(sortBy)) return fallback
    return { sql: `ORDER BY body ->> $SORTBY::text ${dir}`, params: [sortBy], applied: sortBy }
  }

  const whereClause = (where?: { field: string; value: string }): { sql: string; params: Array<string | boolean> } => {
    if (!where) return { sql: "", params: [] }
    if (where.field === "deleted")
      return { sql: `AND deleted = $1`, params: [where.value === "true"] as Array<string | boolean> }
    if (META_COLUMNS.has(where.field)) {
      const column = where.field === "createdAt" ? "created_at" : where.field
      return { sql: `AND ${q(column)} = $1::timestamptz`, params: [where.value] }
    }
    return { sql: `AND body ->> $1::text = $2::text`, params: [where.field, where.value] }
  }

  // $SORTBY is a placeholder for the parameter index, which depends on how many WHERE
  // parameters came before it. Renumbering happens in `page` -- the one place both clauses are
  // combined and the only place the numbering is known.
  const renumber = (sql: string, offset: number) => sql.replace("$SORTBY", `$${offset + 1}`)

  return {
    all: <A>(table: string) =>
      Effect.promise(async () => {
        const t = check(table)
        await ensureTable(schemaName(cube), t)
        return withRole(cube, async (c) => {
          const r = await c.query(
            `SELECT * FROM ${q(schemaName(cube))}.${q(t)} WHERE deleted = false ORDER BY created_at ASC`,
          )
          return r.rows.map(decode) as ReadonlyArray<A>
        })
      }),

    page: <A>(table: string, page: PageRequest, where?: { field: string; value: string }) =>
      Effect.promise(async (): Promise<Page<A>> => {
        const t = check(table)
        await ensureTable(schemaName(cube), t)
        return withRole(cube, async (c) => {
          const w = whereClause(where)
          const o = orderClause(page.sortBy, page.descending ?? false)
          const n = w.params.length
          const osql = renumber(o.sql, n)
          // The sort parameter (if any) takes index n+1; LIMIT and OFFSET come after whatever
          // the WHERE and ORDER clauses actually used.
          const limitIdx = n + 1 + o.params.length
          const offsetIdx = limitIdx + 1
          const count = await c.query(
            `SELECT COUNT(*)::int AS c FROM ${q(schemaName(cube))}.${q(t)} WHERE deleted = false ${w.sql}`,
            w.params,
          )
          const rows = await c.query(
            `SELECT * FROM ${q(schemaName(cube))}.${q(t)} WHERE deleted = false ${w.sql} ${osql} LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
            [...w.params, ...o.params, page.limit, page.offset],
          )
          return {
            rows: rows.rows.map(decode) as ReadonlyArray<A>,
            total: (count.rows[0] as unknown as { c: number }).c,
            offset: page.offset,
            limit: page.limit,
            sortedBy: o.applied,
          }
        })
      }),

    byId: <A>(table: string, id: string) =>
      Effect.promise(async () => {
        const t = check(table)
        await ensureTable(schemaName(cube), t)
        return withRole(cube, async (c) => {
          const r = await c.query(`SELECT * FROM ${q(schemaName(cube))}.${q(t)} WHERE id = $1 AND deleted = false`, [
            id,
          ])
          return r.rows[0] ? (decode(r.rows[0] as Record<string, unknown>) as A) : undefined
        })
      }),

    insert: (table: string, entityType: string, prefix: string, values: Record<string, unknown>) =>
      Effect.promise(async () => {
        const t = check(table)
        await ensureTable(schemaName(cube), t)
        return withRole(cube, async (c) => {
          const row = {
            id: newId(prefix),
            type: entityType,
            createdAt: new Date().toISOString(),
            deleted: false,
            ...values,
          }
          const { id, type, createdAt, deleted, ...body } = row
          await c.query(
            `INSERT INTO ${q(schemaName(cube))}.${q(t)} (id, type, created_at, deleted, version, body)
             VALUES ($1, $2, $3::timestamptz, $4, 1, $5)`,
            [id, type, createdAt, deleted, JSON.stringify(body)],
          )
          await c.query(outboxInsert(cube, t, id, "insert", 1))
          return row
        })
      }),

    update: (table: string, id: string, patch: Record<string, unknown>) =>
      Effect.promise(async () => {
        const t = check(table)
        await ensureTable(schemaName(cube), t)
        return withRole(cube, async (c) => {
          const current = await c.query(`SELECT * FROM ${q(schemaName(cube))}.${q(t)} WHERE id = $1`, [id])
          if (!current.rows[0]) return undefined
          const merged = { ...decode(current.rows[0] as Record<string, unknown>), ...patch }
          const { id: _i, type, createdAt, deleted, ...body } = merged
          const version = ((current.rows[0] as { version: number }).version ?? 1) + 1
          await c.query(
            `UPDATE ${q(schemaName(cube))}.${q(t)}
             SET type = $1, created_at = $2::timestamptz, deleted = $3, version = $4, body = $5
             WHERE id = $6`,
            [String(type), String(createdAt), deleted, version, JSON.stringify(body), id],
          )
          await c.query(outboxInsert(cube, t, id, "update", version))
          return merged
        })
      }),

    count: (table: string) =>
      Effect.promise(async () => {
        const t = check(table)
        await ensureTable(schemaName(cube), t)
        return withRole(cube, async (c) => {
          const r = await c.query(`SELECT COUNT(*)::int AS c FROM ${q(schemaName(cube))}.${q(t)} WHERE deleted = false`)
          return (r.rows[0] as { c: number }).c
        })
      }),
  }
}
