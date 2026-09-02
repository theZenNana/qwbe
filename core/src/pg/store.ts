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

import { Effect } from "effect"
import type { CubeStore } from "../kernel/manifest.ts"
import type { ListWhere, Page, PageRequest } from "../kernel/pagination.ts"
import { type BatchStore, batchFor } from "./batch.ts"
import { ForeignTableError } from "./errors.ts"
import { decode, mergeCustom, newId, orderClause, outboxInsert, renumber, whereClause } from "./rows.ts"
import { ensureCubeSchema, ensureTable, q, schemaName, withRole } from "./setup.ts"

export { ForeignTableError } from "./errors.ts"

/**
 * The row a handler returns IS the response body, and it must equal what was stored: the
 * `body` column is written with JSON.stringify, which drops keys whose value is undefined,
 * while a spread keeps them present-but-undefined. The published row contract reads
 * `custom` as an optional sub-object, so a row carrying `custom: undefined` -- a handler
 * passing "no custom values" the natural way -- fails response encoding. Drop such keys
 * where every row return routes through.
 */
const asStored = <A extends Record<string, unknown>>(row: A): A =>
  Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)) as A

export const storeFor = (
  cube: string,
  tables: ReadonlyArray<string>,
  /** Fields this cube permits sorting by. Anything else is ignored; the response says so. */
  sortable: ReadonlyArray<string> = [],
  /** The raw SQL batch capability is handed over ONLY on the manifest's declared `usesBatch`. */
  withBatch = false,
): CubeStore & { readonly batch?: BatchStore["batch"] } => {
  const allowed = new Set(tables)
  const sortableFields = new Set(sortable)

  const check = (table: string): string => {
    if (!allowed.has(table)) throw new ForeignTableError(cube, table, tables)
    return table
  }

  return {
    all: <A>(table: string) =>
      Effect.promise(async () => {
        const t = check(table)
        await ensureCubeSchema(cube)
        await ensureTable(schemaName(cube), t)
        return withRole(cube, async (c) => {
          const r = await c.query(
            `SELECT * FROM ${q(schemaName(cube))}.${q(t)} WHERE deleted = false ORDER BY created_at ASC`,
          )
          return r.rows.map(decode) as ReadonlyArray<A>
        })
      }),

    page: <A>(
      table: string,
      page: PageRequest,
      where?: { readonly field: string; readonly value: string } | ListWhere,
    ) =>
      Effect.promise(async (): Promise<Page<A>> => {
        const t = check(table)
        await ensureCubeSchema(cube)
        await ensureTable(schemaName(cube), t)
        return withRole(cube, async (c) => {
          const w = whereClause(where)
          const o = orderClause(page.sortBy, page.descending ?? false, sortableFields)
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
        await ensureCubeSchema(cube)
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
        await ensureCubeSchema(cube)
        await ensureTable(schemaName(cube), t)
        return withRole(cube, async (c) => {
          const row = asStored({
            id: newId(prefix),
            type: entityType,
            createdAt: new Date().toISOString(),
            deleted: false,
            ...values,
          })
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
        await ensureCubeSchema(cube)
        await ensureTable(schemaName(cube), t)
        return withRole(cube, async (c) => {
          const current = await c.query(`SELECT * FROM ${q(schemaName(cube))}.${q(t)} WHERE id = $1`, [id])
          if (!current.rows[0]) return undefined
          const merged = { ...decode(current.rows[0] as Record<string, unknown>), ...patch }
          // `custom` merges (rows.ts), so a partial PATCH cannot wipe sibling values.
          const withCustom = mergeCustom(current.rows[0] as Record<string, unknown>, merged)
          const { id: _i, type, createdAt, deleted, ...body } = withCustom
          const version = ((current.rows[0] as { version: number }).version ?? 1) + 1
          await c.query(
            `UPDATE ${q(schemaName(cube))}.${q(t)}
             SET type = $1, created_at = $2::timestamptz, deleted = $3, version = $4, body = $5
             WHERE id = $6`,
            [String(type), String(createdAt), deleted, version, JSON.stringify(body), id],
          )
          // ADR-0001 section 5 lists delete as its own op: a soft delete is not an update.
          await c.query(outboxInsert(cube, t, id, deleted === true ? "delete" : "update", version))
          // The row stores the MERGE, so the response must too -- a
          // PATCH response reporting `custom` as only the patched keys would lie about the row.
          return asStored({ ...withCustom, id })
        })
      }),

    ...(withBatch ? { batch: batchFor(cube) } : {}),

    count: (table: string) =>
      Effect.promise(async () => {
        const t = check(table)
        await ensureCubeSchema(cube)
        await ensureTable(schemaName(cube), t)
        return withRole(cube, async (c) => {
          const r = await c.query(`SELECT COUNT(*)::int AS c FROM ${q(schemaName(cube))}.${q(t)} WHERE deleted = false`)
          return (r.rows[0] as { c: number }).c
        })
      }),
  }
}
