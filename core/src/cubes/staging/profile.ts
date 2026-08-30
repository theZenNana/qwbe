// Profiling: lay every record on top of the others and look at the outline.
//
// Everything heavy happens IN SQL, one pass per field over the jsonb body -- the database
// returns a handful of buckets per field, never rows. The JavaScript below only merges those
// buckets into the response shape. Field names travel as bound parameters (`body->'record'->>$n`),
// pattern sources come from shapes.ts (the same constants the JS detector tests), and table
// names come from the cube's own manifest constants -- quoted identifiers, never input.

import type { SqlStatement } from "./batch.ts"
import type { FieldProfile, ShapeCount } from "./contract.ts"
import { ENUM_MAX_DISTINCT, SHAPE_PATTERNS } from "./shapes.ts"

/** The raw record lives nested under `record`, beside the set link and the row number. */
// Table and key names in these statements are the cube's own constants; everything that can
// vary -- set ids AND field names -- travels as a bound parameter. Nothing user-reachable is
// ever concatenated into the SQL text.

/** Distinct field names across the set, plus the number of rows carrying each. */
export const fieldNamesStatement = (setId: string): SqlStatement => ({
  text: `SELECT k, c::int FROM (
           SELECT jsonb_object_keys(body->'record') AS k, count(*)::int AS c
           FROM "rows" WHERE deleted = false AND body->>'setId' = $1
           GROUP BY k
         ) f ORDER BY k ASC`,
  values: [setId],
})

/** Total rows in the set (the denominator of every fill rate). */
export const totalRowsStatement = (setId: string): SqlStatement => ({
  text: `SELECT count(*)::int AS n FROM "rows" WHERE deleted = false AND body->>'setId' = $1`,
  values: [setId],
})

/** Example values are truncated to this length IN SQL (`left`) AND again in JS. A profile is
 *  a shape summary, not a data export: whole raw values -- names, addresses, note bodies --
 *  must never reach a `staging:read` caller (QWB-45 review, blocker 3). */
export const TOP_MAX_CHARS = 40

/** ONE pass over the set for ONE field: fill, distinct, and the shape buckets.
 *  The empty string is NOT a filled value (it must not inflate fillRate to 100% nor land in
 *  the value buckets -- QWB-45 review, item 7), and `other_distinct` counts distinct values
 *  restricted to the leftover (non-number/date/email/phone) bucket, which is what the
 *  enum-vs-text decision actually reads (QWB-45 review, item 17). */
export const fieldStats = (field: string, setId: string): SqlStatement => ({
  text: `SELECT count(v) FILTER (WHERE v <> '')::int AS filled,
           count(DISTINCT v) FILTER (WHERE v <> '')::int AS distinct_values,
           count(DISTINCT v) FILTER (WHERE v <> '' AND v !~ $2 AND v !~ $3 AND v !~ $4 AND v !~ $5)::int AS other_distinct,
           count(v) FILTER (WHERE v <> '' AND v ~ $2)::int AS number_count,
           count(v) FILTER (WHERE v <> '' AND v !~ $2 AND v ~ $3)::int AS date_count,
           count(v) FILTER (WHERE v <> '' AND v !~ $2 AND v !~ $3 AND v ~ $4)::int AS email_count,
           count(v) FILTER (WHERE v <> '' AND v !~ $2 AND v !~ $3 AND v !~ $4 AND v ~ $5)::int AS phone_count
         FROM (SELECT body->'record'->>$1 AS v FROM "rows"
               WHERE deleted = false AND body->>'setId' = $6) s`,
  values: [field, SHAPE_PATTERNS.number, SHAPE_PATTERNS.date, SHAPE_PATTERNS.email, SHAPE_PATTERNS.phone, setId],
})

/** Example values, most frequent first, truncated IN SQL to TOP_MAX_CHARS -- and NEVER issued
 *  for a sensitive field. */
export const fieldTop = (field: string, setId: string): SqlStatement => ({
  text: `SELECT left(v, ${TOP_MAX_CHARS}) AS v, count(*)::int AS c FROM (SELECT body->'record'->>$1 AS v FROM "rows"
          WHERE deleted = false AND body->>'setId' = $2) s
         WHERE v IS NOT NULL AND v <> ''
         GROUP BY left(v, ${TOP_MAX_CHARS}) ORDER BY c DESC, v ASC LIMIT 5`,
  values: [field, setId],
})

export type FieldStats = {
  readonly filled: number
  readonly distinct_values: number
  readonly other_distinct: number
  readonly number_count: number
  readonly date_count: number
  readonly email_count: number
  readonly phone_count: number
}

/**
 * Turn one field's SQL buckets into its profile. `other` = filled values that are none of the
 * four specific shapes: free text, or an enum hiding in there. The enum-vs-text decision reads
 * `other_distinct` -- distinct values restricted to the leftover bucket, not the whole field
 * (a field with 3 numbers and 2 free-text values is NOT an enum). Sensitive fields get `top`
 * NEVER: the caller does not even fetch it, and passing no top here is the second half of the
 * suppression (tested in profile.test.ts). Example values are truncated a second time here,
 * so the response contract holds even if the SQL truncation above is ever changed.
 */
export const aggregateField = (
  field: string,
  stats: FieldStats,
  totalRows: number,
  top: ReadonlyArray<{ readonly value: string; readonly count: number }> | undefined,
): FieldProfile => {
  const specific: ShapeCount[] = [
    { shape: "number", count: stats.number_count },
    { shape: "date", count: stats.date_count },
    { shape: "email", count: stats.email_count },
    { shape: "phone", count: stats.phone_count },
  ]

  const other = stats.filled - specific.reduce((sum, s) => sum + s.count, 0)
  const shapes: ShapeCount[] = specific.filter((s) => s.count > 0).map((s) => ({ shape: s.shape, count: s.count }))
  if (other > 0) {
    shapes.push({ shape: stats.other_distinct <= ENUM_MAX_DISTINCT ? "enum" : "text", count: other })
  }
  const fillRate = totalRows > 0 ? Math.round((stats.filled / totalRows) * 1000) / 10 : 0
  const profile: { top?: Array<{ value: string; count: number }> } & {
    field: string
    filled: number
    fillRate: number
    distinct: number
    shapes: ShapeCount[]
  } = {
    field,
    filled: stats.filled,
    fillRate,
    distinct: stats.distinct_values,
    shapes,
  }
  if (top !== undefined) {
    profile.top = top.map((t) => ({ value: String(t.value).slice(0, TOP_MAX_CHARS), count: Number(t.count) }))
  }
  return profile
}
