// Row mapping and SQL-clause building for the Postgres store, split out of store.ts (QWB-44)
// when the file passed its cap. Pure functions: no pool, no transactions.

import { randomBytes } from "node:crypto"
import type { ListWhere } from "../kernel/pagination.ts"
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
 *
 * QWB-54 widened the input from one `{field, value}` pair to `ListWhere`, so the generic list
 * handler's whole vocabulary -- several equalities, a batch of ids, a prefix search -- is built
 * HERE, in SQL, and never by reading rows and filtering them in JavaScript. The single-pair
 * shape still works and means the same thing; `relational.search` still passes it.
 */
/** Bind a value and return the placeholder it got. The order of calls IS the parameter order. */
const bind = (params: Array<unknown>, value: unknown): string => {
  params.push(value)
  return `$${params.length}`
}

const column = (field: string): string => q(field === "createdAt" ? "created_at" : field)

const equalsSql = (params: Array<unknown>, field: string, value: string): string => {
  if (field === "deleted") return `AND deleted = ${bind(params, value === "true")}`
  if (META_COLUMNS.has(field)) return `AND ${column(field)}::text = ${bind(params, value)}`
  return `AND body ->> ${bind(params, field)}::text = ${bind(params, value)}::text`
}

// ILIKE reads `%` and `_` as wildcards, so a caller searching for "50%" must not match every
// row. Escaped with the default backslash escape character.
const escapeLike = (text: string): string => text.replaceAll(/([\\%_])/g, "\\$1")

const searchSql = (params: Array<unknown>, text: string, fields: ReadonlyArray<string>): string => {
  if (fields.length === 0) return ""
  // One pattern parameter shared by every OR branch -- the prefix is the same for all of them.
  const pattern = bind(params, `${escapeLike(text)}%`)
  const branches = fields.map((f) =>
    META_COLUMNS.has(f) ? `${column(f)}::text ILIKE ${pattern}` : `body ->> ${bind(params, f)}::text ILIKE ${pattern}`,
  )
  return `AND (${branches.join(" OR ")})`
}

export const whereClause = (
  where?: { field: string; value: string } | ListWhere,
): { sql: string; params: Array<unknown> } => {
  if (!where) return { sql: "", params: [] }
  const criteria: ListWhere = "field" in where ? { equals: [where] } : where
  const params: Array<unknown> = []
  const parts: Array<string> = []
  for (const e of criteria.equals ?? []) parts.push(equalsSql(params, e.field, e.value))
  // `= ANY($n::text[])` is one bound array, so a batch of ids costs one parameter whatever its
  // size -- and an id never becomes SQL text.
  if (criteria.ids && criteria.ids.length > 0) {
    parts.push(`AND id = ANY(${bind(params, [...criteria.ids])}::text[])`)
  }
  if (criteria.q && criteria.q.text !== "") {
    const sql = searchSql(params, criteria.q.text, criteria.q.fields)
    if (sql !== "") parts.push(sql)
  }
  return { sql: parts.join(" "), params }
}

// $SORTBY is a placeholder for the parameter index, which depends on how many WHERE
// parameters came before it. Renumbering happens in `page` -- the one place both clauses are
// combined and the only place the numbering is known.
export const renumber = (sql: string, offset: number) => sql.replace("$SORTBY", `$${offset + 1}`)

/**
 * QWB-46: `custom` is the reserved sub-object of a row body holding undeclared (custom-field)
 * keys. A PATCH is partial, so its `custom` MERGES with the row's -- replacing it wholesale
 * would silently drop every custom value the patch did not mention. Declared fields keep the
 * plain shallow-merge semantics the caller applies before this runs.
 */
export const mergeCustom = (
  currentRow: Record<string, unknown>,
  merged: Record<string, unknown>,
): Record<string, unknown> => {
  const previousCustom = (currentRow as { body?: { custom?: unknown } }).body?.custom
  const patchCustom = merged.custom
  if (
    typeof patchCustom === "object" &&
    patchCustom !== null &&
    !Array.isArray(patchCustom) &&
    typeof previousCustom === "object" &&
    previousCustom !== null &&
    !Array.isArray(previousCustom)
  ) {
    return {
      ...merged,
      custom: {
        ...(previousCustom as Record<string, unknown>),
        ...(patchCustom as Record<string, unknown>),
      },
    }
  }
  return merged
}
