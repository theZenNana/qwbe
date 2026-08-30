// The import path: raw text in, rows in the table, tallies on the set -- one transaction per
// chunk, so a 100k-row import is a few hundred small transactions instead of 100k single-row
// ones, and the API thread is never held longer than one batch.
//
// Row body shape: `{ setId, rowNum, record }`. The cube's standard row shape has ONE jsonb body
// and the set link must live beside the raw record, so the record is nested under `record`;
// profiling reads `body->'record'`. `type` is `staging.row` for every imported row.

import { randomBytes } from "node:crypto"
import type { SqlStatement } from "./batch.ts"
import { TABLES } from "./contract.ts"
import { type Malformed, type ParsedRecord, parseChunk } from "./parse.ts"
/** Keep at most this many malformed lines ON the set; the counts keep the full total. */
export const MALFORMED_SAMPLE_MAX = 20

export type SetRow = {
  readonly id: string
  readonly name: string
  readonly format: "jsonl" | "csv"
  readonly sourceFile: string
  readonly state: "importing" | "done" | "failed"
  readonly rowCount: number
  readonly malformedCount: number
  readonly malformedSample: ReadonlyArray<{ readonly line: number; readonly reason: string }>
  readonly sensitiveFields: ReadonlyArray<string>
  readonly createdAt: string
}

/** One multi-row INSERT, up to `batchSize` rows -- parameters, never concatenated values. */
export const insertRowsStatement = (
  records: ReadonlyArray<ParsedRecord>,
  setId: string,
  firstRowNum: number,
  batchSize = 500,
): ReadonlyArray<SqlStatement> => {
  const statements: SqlStatement[] = []
  for (let start = 0; start < records.length; start += batchSize) {
    const slice = records.slice(start, batchSize + start)
    const values: unknown[] = []
    const rows = slice.map((record, i) => {
      values.push(`row-${randomBytes(4).toString("hex")}`, "staging.row", new Date().toISOString(), false, 1, {
        setId,
        rowNum: firstRowNum + start + i,
        record,
      })
      const n = i * 6
      return `($${n + 1}, $${n + 2}, $${n + 3}::timestamptz, $${n + 4}, $${n + 5}, $${n + 6})`
    })
    statements.push({
      text: `INSERT INTO "${TABLES.rows}" (id, type, created_at, deleted, version, body)
             VALUES ${rows.join(", ")}`,
      values,
    })
  }
  return statements
}

/**
 * Bump the set's tallies in SQL, not by read-modify-write in JavaScript: `body` on the right
 * side of the UPDATE sees the OLD row, and the two counters are different keys, so one
 * statement is enough. The malformed sample is capped here (not in SQL) by sending only what
 * still fits, so the sample on the set never grows past MALFORMED_SAMPLE_MAX.
 */
export const tallyStatement = (
  setId: string,
  parsedDelta: number,
  malformedDelta: number,
  sampleDelta: ReadonlyArray<{ line: number; reason: string }>,
): SqlStatement => ({
  text: `UPDATE "${TABLES.sets}"
         SET body = jsonb_set(
               jsonb_set(
                 jsonb_set(body, '{rowCount}', to_jsonb((body->>'rowCount')::int + $2)),
                 '{malformedCount}', to_jsonb((body->>'malformedCount')::int + $3)),
               '{malformedSample}', body->'malformedSample' || $4::jsonb)
         WHERE id = $1`,
  values: [setId, parsedDelta, malformedDelta, JSON.stringify(sampleDelta)],
})

/** Cap the per-response sample so a set's stored sample stays bounded across chunks. */
export const capSample = (
  current: ReadonlyArray<{ readonly line: number; readonly reason: string }>,
  fresh: ReadonlyArray<Malformed>,
): ReadonlyArray<{ line: number; reason: string }> =>
  fresh.slice(0, Math.max(0, MALFORMED_SAMPLE_MAX - current.length)).map((m) => ({ line: m.line, reason: m.reason }))

/** Result of one chunk: what was parsed, what was refused, tallies to apply. */
export const applyChunk = (
  set: SetRow,
  text: string,
  startLine: number,
): {
  readonly parsed: number
  readonly malformed: ReadonlyArray<Malformed>
  readonly statements: ReadonlyArray<SqlStatement>
} => {
  const { records, malformed } = parseChunk(set.format, text, startLine)
  const statements = [
    ...insertRowsStatement(records, set.id, set.rowCount + 1),
    tallyStatement(set.id, records.length, malformed.length, capSample(set.malformedSample, malformed)),
  ]
  return { parsed: records.length, malformed, statements }
}
