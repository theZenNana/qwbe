// Row mapping and SQL-clause building for the Postgres store, split out of store.ts (QWB-44)
// when the file passed its cap. Pure functions: no pool, no transactions.

import { randomBytes } from "node:crypto"
import { q } from "./setup.ts"

/** Ids are random, not sequential -- see the comment this replaces from the SQLite store. */
export const newId = (prefix: string) => `${prefix}-${randomBytes(4).toString("hex")}`

export const decode = (row: Record<string, unknown>): Record<string, unknown> => ({
  id: row.id,
  type: row.type,
  createdAt: new Date(row.created_at as string).toISOString(),
  deleted: row.deleted === true,
  ...(row.body as Record<string, unknown>),
})

/** Only these may be interpolated into SQL. Everything else is a bound parameter. */
export const META_COLUMNS = new Set(["id", "type", "createdAt", "deleted"])

export const outboxInsert = (cube: string, table: string, id: string, op: string, version: number) => ({
  text: `INSERT INTO qwbe.outbox (cube, "table", row_id, op, version) VALUES ($1, $2, $3, $4, $5)`,
  values: [cube, table, id, op, version],
})

/** Prepared together with the WHERE clause so COUNT and the page always share a predicate. */
export const orderClause = (sortBy: string | undefined, descending: boolean, sortableFields: ReadonlySet<string>) => {
  const dir = descending ? "DESC" : "ASC"
  const fallback = { sql: `ORDER BY created_at ${dir}`, params: [] as Array<string>, applied: "createdAt" }
  if (!sortBy) return fallback
  if (META_COLUMNS.has(sortBy)) {
    const column = sortBy === "createdAt" ? "created_at" : sortBy
    return { sql: `ORDER BY ${q(column)} ${dir}`, params: [] as Array<string>, applied: sortBy }
  }
  if (!sortableFields.has(sortBy)) return fallback
  // jsonb ordering (`body -> $n`), not text ordering (`body ->> $n`): the SQLite store sorted
  // by the JSON value's own type, so 9 < 10 numerically and true > false. Text ordering would
  // put "10" before "9" and silently change every numeric cube's page order and boundaries.
  return { sql: `ORDER BY body -> $SORTBY ${dir}`, params: [sortBy], applied: sortBy }
}

/**
 * WHERE clauses. Two documented semantics changes from the SQLite store:
 *
 *   - `deleted`: the old store compared the string "true"/"false" against an INTEGER column,
 *     so `deleted=false` matched NOTHING. Here the value is bound as a real boolean, so
 *     `deleted=false` returns the live rows and `deleted=true` the soft-deleted ones.
 *   - `createdAt` is compared AS TEXT, never cast to timestamptz: a non-timestamp value must
 *     yield an empty page, exactly like the old store, not a cast error that escapes
 *     `Effect.promise` as a defect.
 */
export const whereClause = (where?: {
  field: string
  value: string
}): { sql: string; params: Array<string | boolean> } => {
  if (!where) return { sql: "", params: [] }
  if (where.field === "deleted")
    return { sql: `AND deleted = $1`, params: [where.value === "true"] as Array<string | boolean> }
  if (META_COLUMNS.has(where.field)) {
    const column = where.field === "createdAt" ? "created_at" : where.field
    return { sql: `AND ${q(column)}::text = $1`, params: [where.value] }
  }
  return { sql: `AND body ->> $1::text = $2::text`, params: [where.field, where.value] }
}

// $SORTBY is a placeholder for the parameter index, which depends on how many WHERE
// parameters came before it. Renumbering happens in `page` -- the one place both clauses are
// combined and the only place the numbering is known.
export const renumber = (sql: string, offset: number) => sql.replace("$SORTBY", `$${offset + 1}`)
