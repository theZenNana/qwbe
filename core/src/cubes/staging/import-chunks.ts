// The import path: raw text in, rows in the table, tallies on the set -- one transaction per
// chunk, so a 100k-row import is a few hundred small transactions instead of 100k single-row
// ones, and the API thread is never held longer than one batch.
//
// Row body shape: `{ setId, rowNum, record }`. The cube's standard row shape has ONE jsonb body
// and the set link must live beside the raw record, so the record is nested under `record`;
// profiling reads `body->'record'`. `type` is `staging.row` for every imported row.
//
// Concurrency (QWB-45 review, item 15): the row number base and the malformed sample used to
// be read from the set in a SEPARATE transaction before the batch, so two concurrent chunks
// on one set assigned overlapping rowNums. Now the batch opens with a per-set advisory lock
// (serialising chunks on one set), the row number base is `count(*)` computed INSIDE the same
// transaction, and the sample is capped in SQL against the live row.

import { randomBytes } from "node:crypto"
import type { SqlStatement } from "./batch.ts"
import { TABLES } from "./contract.ts"
import { csvHeaderOf, type Malformed, type ParsedRecord, parseChunk } from "./parse.ts"

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
  /** CSV only: the header stored at the first chunk, reused to parse every later chunk. */
  readonly csvHeader?: ReadonlyArray<string>
  readonly createdAt: string
}

/**
 * One multi-row INSERT per `batchSize` rows -- parameters, never concatenated values. The row
 * number base is the LIVE row count of the set (same transaction, after the advisory lock the
 * caller put first in the batch), so concurrent chunks cannot overlap rowNums. Per row five
 * bound values; the relative row offset `rn` comes as a value, the base is SQL.
 */
export const insertRowsStatement = (
  records: ReadonlyArray<ParsedRecord>,
  setId: string,
  batchSize = 500,
): ReadonlyArray<SqlStatement> => {
  const statements: SqlStatement[] = []
  for (let start = 0; start < records.length; start += batchSize) {
    const slice = records.slice(start, batchSize + start)
    const values: unknown[] = [setId]
    const rows = slice.map((record, i) => {
      // 12 random bytes: a 100k-row import makes 4-byte ids collide (birthday bound) -- seen
      // live as a duplicate-key failure at ~64k rows. Deterministic ids would be safer still,
      // but a re-import of a deleted set would then collide with nothing left to distinguish.
      const n = values.length
      values.push(
        `row-${randomBytes(12).toString("hex")}`,
        "staging.row",
        new Date().toISOString(),
        start + i,
        JSON.stringify(record),
      )
      return `($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}::int, $${n + 5}::jsonb)`
    })
    statements.push({
      text: `WITH base AS (SELECT count(*)::int AS n FROM "${TABLES.rows}" WHERE body->>'setId' = $1)
             INSERT INTO "${TABLES.rows}" (id, type, created_at, deleted, version, body)
             SELECT x.id, x.type, x.created_at, false, 1,
                    jsonb_build_object('setId', $1, 'rowNum', base.n + x.rn, 'record', x.rec)
             FROM base, (VALUES ${rows.join(", ")}) AS x(id, type, created_at, rn, rec)`,
      values,
    })
  }
  return statements
}

/** Serialise chunks on one set: transaction-scoped advisory lock, first statement of the batch. */
export const lockStatement = (setId: string): SqlStatement => ({
  text: `SELECT pg_advisory_xact_lock(hashtext($1))`,
  values: [setId],
})

/**
 * Bump the set's tallies in SQL, not by read-modify-write in JavaScript: `body` on the right
 * side of the UPDATE sees the OLD row, and the two counters are different keys, so one
 * statement is enough. The malformed sample is capped IN SQL against the live sample
 * (`[1:N]` slice), so a sample stays bounded even when two chunks race. On the first CSV
 * chunk the header row is stored on the set, for every later chunk to reuse.
 */
export const tallyStatement = (
  setId: string,
  parsedDelta: number,
  malformedDelta: number,
  sampleDelta: ReadonlyArray<Malformed>,
  csvHeader?: ReadonlyArray<string>,
): SqlStatement => {
  const sample = `(body->'malformedSample' || $4::jsonb)[1:${MALFORMED_SAMPLE_MAX}]`
  const inner = `jsonb_set(
                 jsonb_set(
                   jsonb_set(body, '{rowCount}', to_jsonb((body->>'rowCount')::int + $2)),
                   '{malformedCount}', to_jsonb((body->>'malformedCount')::int + $3)),
                 '{malformedSample}', ${sample})`
  return csvHeader === undefined
    ? {
        text: `UPDATE "${TABLES.sets}" SET body = ${inner} WHERE id = $1`,
        values: [setId, parsedDelta, malformedDelta, JSON.stringify(sampleDelta)],
      }
    : {
        text: `UPDATE "${TABLES.sets}"
               SET body = jsonb_set(${inner}, '{csvHeader}', $5::jsonb)
               WHERE id = $1`,
        values: [setId, parsedDelta, malformedDelta, JSON.stringify(sampleDelta), JSON.stringify(csvHeader)],
      }
}

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
  // CSV: the header lives on the set from the first chunk on. Later chunks hold data rows
  // only -- parsing them with the stored header is what keeps a multi-chunk import from
  // eating one data row per chunk (QWB-45 review, blocker 1).
  const isCsv = set.format === "csv"
  const firstChunk = set.rowCount === 0
  const storedHeader = set.csvHeader
  const { records, malformed } =
    isCsv && !firstChunk && storedHeader !== undefined
      ? parseChunk("csv", text, startLine, storedHeader)
      : parseChunk(set.format, text, startLine)
  const header = isCsv && firstChunk && text.trim() !== "" ? csvHeaderOf(text) : undefined
  const statements = [
    lockStatement(set.id),
    ...insertRowsStatement(records, set.id),
    tallyStatement(set.id, records.length, malformed.length, malformed, header),
  ]
  return { parsed: records.length, malformed, statements }
}
