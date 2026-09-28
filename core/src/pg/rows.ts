// Row mapping and SQL-clause building for the Postgres store, split out of store.ts.
// when the file passed its cap. Pure functions: no pool, no transactions -- the `sql` they take
// only builds fragments, it runs nothing.

import { randomBytes } from "node:crypto"
import { Statement } from "@effect/sql"
import { PgClient } from "@effect/sql-pg"
import { DateTime, Effect } from "effect"
import { checkCustomObject } from "../custom-values.ts"
import type { ListWhere } from "../kernel/pagination.ts"
import type { Where } from "../kernel/store-contract.ts"
import { CustomCapError } from "./errors.ts"
import { ident } from "./setup.ts"

/** Builds and compiles statements with the Postgres dialect and runs nothing: for no-DB tests. */
export const compileOnly = Statement.make(Effect.dieMessage("compile only"), PgClient.makeCompiler(), [], undefined)

/**
 * Ids are random, not sequential -- see the comment this replaces from the SQLite store.
 * 128 bits: 32 bits collided past ~77,000 rows (Qwbe#73). Older rows keep 8-hex ids.
 */
export const newId = (prefix: string) => `${prefix}-${randomBytes(16).toString("hex")}`

export const decode = (row: Record<string, unknown>): Record<string, unknown> => ({
  id: row.id,
  type: row.type,
  createdAt: DateTime.formatIso(DateTime.unsafeMake(row.created_at as Date)),
  deleted: row.deleted === true,
  ...(row.body as Record<string, unknown>),
})

/** Only these may be interpolated into SQL. Everything else is a bound parameter. */
const META_COLUMNS = new Set(["id", "type", "createdAt", "deleted"])

export const outboxInsert = (
  sql: Statement.Constructor,
  cube: string,
  table: string,
  id: string,
  op: string,
  version: number,
) =>
  sql`INSERT INTO qwbe.outbox (cube, "table", row_id, op, version) VALUES (${cube}, ${table}, ${id}, ${op}, ${version})`

/**
 * The activity row (Echo A1), written in the SAME transaction as the mutation. The actor is
 * the authenticated account or `undefined` (recorded as NULL) -- never caller-supplied.
 */
export const activityInsert = (
  sql: Statement.Constructor,
  cube: string,
  entityType: string,
  id: string,
  op: string,
  version: number | null,
  actor: { readonly id: string; readonly username: string } | undefined,
  changes: Record<string, { from?: unknown; to?: unknown }>,
  /** Echo A2 comments: set only by the comment seam, linking the row to qwbe.comment. */
  commentId: string | null = null,
) =>
  sql`INSERT INTO qwbe.activity (cube, entity_type, row_id, op, version, actor_id, actor_username, changes, comment_id)
      VALUES (${cube}, ${entityType}, ${id}, ${op}, ${version}, ${actor?.id ?? null}, ${actor?.username ?? null},
              ${JSON.stringify(changes)}::jsonb, ${commentId})`

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * The `changes` payload of an activity row, as a pure function next to `mergeCustom`.
 *
 * `before === null` (an insert) records every body key as `{ "to": v }`; an update records
 * only keys whose JSON differs, as `{ "from", "to" }`. The reserved `custom` sub-object is
 * diffed PER SUB-KEY, keyed `custom.<name>`, so a PATCH touching one custom value does not
 * republish the whole object. Undefined and missing keys are equivalent (JSON.stringify drops
 * undefined, and so does the row body the store writes).
 */
export const diffBody = (
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): Record<string, { from?: unknown; to?: unknown }> => {
  const out: Record<string, { from?: unknown; to?: unknown }> = {}
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)])
  for (const key of keys) {
    if (key === "custom") {
      // Only object-vs-object diffs sub-keys; anything else is not republished.
      const obj = (v: unknown): Record<string, unknown> | undefined =>
        typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
      const cb = obj(before?.custom)
      const ca = obj(after.custom)
      if (cb === undefined || ca === undefined) continue
      for (const name of new Set([...Object.keys(cb), ...Object.keys(ca)])) {
        const from = cb[name]
        const to = ca[name]
        if (sameJson(from, to)) continue
        out[`custom.${name}`] =
          before === null || from === undefined ? { to } : to === undefined ? { from } : { from, to }
      }
      continue
    }
    const from = before?.[key]
    const to = after[key]
    if (sameJson(from, to)) continue
    // A key absent before the update records as an insertion, and a key absent after records
    // as a removal: the object never carries an explicit undefined.
    out[key] = before === null || from === undefined ? { to } : to === undefined ? { from } : { from, to }
  }
  return out
}

/** Prepared together with the WHERE clause so COUNT and the page always share a predicate. */
export const orderClause = (
  sql: Statement.Constructor,
  sortBy: string | undefined,
  descending: boolean,
  sortableFields: ReadonlySet<string>,
): { readonly sql: Statement.Fragment; readonly applied: string } => {
  const dir = sql.literal(descending ? "DESC" : "ASC")
  const fallback = { sql: sql`ORDER BY created_at ${dir}`, applied: "createdAt" }
  if (!sortBy) return fallback
  if (META_COLUMNS.has(sortBy)) return { sql: sql`ORDER BY ${column(sql, sortBy)} ${dir}`, applied: sortBy }
  if (!sortableFields.has(sortBy)) return fallback
  // jsonb ordering (`body -> field`), not text ordering (`body ->> field`): the SQLite store
  // sorted by the JSON value's own type, so 9 < 10 numerically and true > false. Text ordering
  // would put "10" before "9" and silently change every numeric cube's page order and boundaries.
  // Ties oldest first: without a tie-breaker, OFFSET paging may repeat or skip equal rows.
  return { sql: sql`ORDER BY body -> ${sortBy} ${dir}, created_at ASC`, applied: sortBy }
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
 * The generic list handler's whole vocabulary -- several equalities, a batch of ids, a prefix
 * search -- is built HERE, in SQL, and never by reading rows and filtering them in JavaScript.
 * One pair or the full ListWhere.
 */
const column = (sql: Statement.Constructor, field: string) => ident(sql, field === "createdAt" ? "created_at" : field)

const equalsSql = (sql: Statement.Constructor, field: string, value: string) => {
  if (field === "deleted") return sql`AND deleted = ${value === "true"}`
  if (META_COLUMNS.has(field)) return sql`AND ${column(sql, field)}::text = ${value}`
  return sql`AND body ->> ${field}::text = ${value}::text`
}

// ILIKE reads `%` and `_` as wildcards, so a caller searching for "50%" must not match every
// row. Escaped with the default backslash escape character.
const escapeLike = (text: string): string => text.replaceAll(/([\\%_])/g, "\\$1")

const searchSql = (sql: Statement.Constructor, text: string, fields: ReadonlyArray<string>) => {
  // The same prefix for every OR branch, bound once per branch.
  const pattern = `${escapeLike(text)}%`
  const branches = fields.map((f) =>
    META_COLUMNS.has(f) ? sql`${column(sql, f)}::text ILIKE ${pattern}` : sql`body ->> ${f}::text ILIKE ${pattern}`,
  )
  return sql`AND (${sql.join(" OR ", false)(branches)})`
}

export const whereClause = (sql: Statement.Constructor, where?: Where): Statement.Fragment => {
  if (!where) return sql.literal("")
  const criteria: ListWhere = Array.isArray(where)
    ? { equals: where }
    : "field" in where
      ? { equals: [where] }
      : (where as ListWhere)
  const parts: Array<Statement.Fragment> = []
  for (const e of criteria.equals ?? []) parts.push(equalsSql(sql, e.field, e.value))
  // `= ANY(array::text[])` is one bound array, so a batch of ids costs one parameter whatever
  // its size -- and an id never becomes SQL text.
  if (criteria.ids && criteria.ids.length > 0) parts.push(sql`AND id = ANY(${[...criteria.ids]}::text[])`)
  for (const s of criteria.in ?? []) {
    const values = [...s.values]
    if (values.length === 0) parts.push(sql`AND FALSE`)
    else if (META_COLUMNS.has(s.field)) parts.push(sql`AND ${column(sql, s.field)}::text = ANY(${values}::text[])`)
    else parts.push(sql`AND body ->> ${s.field}::text = ANY(${values}::text[])`)
  }
  // COLLATE "C" so the bounds compare as bytes, exactly as the JS `>=`/`<=` they replace; the
  // database's default collation may order punctuation differently.
  const r = criteria.range
  if (r?.from !== undefined) parts.push(sql`AND (body ->> ${r.field}::text) COLLATE "C" >= ${r.from}::text`)
  if (r?.to !== undefined) parts.push(sql`AND (body ->> ${r.field}::text) COLLATE "C" <= ${r.to}::text`)
  if (criteria.q && criteria.q.text !== "" && criteria.q.fields.length > 0) {
    parts.push(searchSql(sql, criteria.q.text, criteria.q.fields))
  }
  return sql.join(" ", false)(parts)
}

/**
 * `custom` is the reserved sub-object of a row body holding undeclared (custom-field)
 * keys. A PATCH is partial, so its `custom` MERGES with the row's -- replacing it wholesale
 * would silently drop every custom value the patch did not mention. Declared fields keep the
 * plain shallow-merge semantics the caller applies before this runs.
 *
 * the caps apply to the MERGED result, not only to what one
 * request carried. A row with 30 keys could otherwise take two more per PATCH forever -- the
 * merge is the last application-level door, and Postgres holds the same rule in a CHECK
 * constraint (setup.ts), so the limit exists even without the application.
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
    const combined = {
      ...(previousCustom as Record<string, unknown>),
      ...(patchCustom as Record<string, unknown>),
    }
    const why = checkCustomObject(combined)
    if (why) throw new CustomCapError(why)
    return { ...merged, custom: combined }
  }
  return merged
}
