// The profile handler, split from handlers.ts for the size cap.
//
// One batch, one transaction: total rows, then per field ONE aggregation pass -- plus a
// top-values pass only for fields that are NOT sensitive. Suppression is the absence of the
// query: a sensitive field's examples are never even fetched, not filtered afterwards.

import { Effect } from "effect"
import type { BatchStore, SqlStatement } from "./batch.ts"
import type { StagingSet } from "./contract.ts"
import { aggregateField, fieldNamesStatement, fieldStats, fieldTop, totalRowsStatement } from "./profile.ts"
import { ENUM_MAX_DISTINCT } from "./shapes.ts"

const rowsAt = (results: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>, i: number) => results[i] ?? []

const toStats = (row: Record<string, unknown>) => ({
  filled: Number(row.filled),
  distinct_values: Number(row.distinct_values),
  other_distinct: Number(row.other_distinct),
  number_count: Number(row.number_count),
  date_count: Number(row.date_count),
  email_count: Number(row.email_count),
  phone_count: Number(row.phone_count),
})

/** A set's field count is source-controlled and unbounded, and the profile runs 1 + 2 x fields
 *  statements in ONE transaction on ONE connection -- so the field list is capped here (the
 *  response says so via `fieldsTruncated`) instead of building an unbounded batch. */
export const MAX_PROFILE_FIELDS = 200

export const profileHandler = (batched: BatchStore, set: StagingSet) =>
  Effect.gen(function* () {
    const fieldRows = yield* batched.batch([fieldNamesStatement(set.id)])
    const allNames = (fieldRows[0] ?? []).map((r) => String(r.k))
    const names = allNames.slice(0, MAX_PROFILE_FIELDS)
    const truncated = allNames.length > MAX_PROFILE_FIELDS
    const statements: SqlStatement[] = [totalRowsStatement(set.id)]
    const wantsTop: boolean[] = []
    for (const field of names) {
      statements.push(fieldStats(field, set.id))
      const sensitive = set.sensitiveFields.includes(field)
      wantsTop.push(!sensitive)
      if (!sensitive) statements.push(fieldTop(field, set.id))
    }
    const results = yield* batched.batch(statements)
    const total = Number((rowsAt(results, 0)[0] as { n: number } | undefined)?.n ?? 0)
    let cursor = 1
    const fields = names.map((field, i) => {
      const stats = toStats(rowsAt(results, cursor++)[0] ?? {})
      let top: Array<{ value: string; count: number }> | undefined
      if (wantsTop[i]) {
        top = rowsAt(results, cursor).map((r) => ({ value: String(r.v), count: Number(r.c) }))
        cursor++
      }
      return aggregateField(field, stats, total, top)
    })
    return {
      setId: set.id,
      rows: total,
      enumMax: ENUM_MAX_DISTINCT,
      ...(truncated ? { fieldsTruncated: true } : {}),
      fields,
    }
  })
