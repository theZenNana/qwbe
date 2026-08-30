// Unit tests for the import parsers and the malformed-line counting. The rule under test:
// a malformed line is COUNTED and reported with its ABSOLUTE line number, and the import
// continues -- one bad line never costs the good ones around it.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  applyChunk,
  insertRowsStatement,
  lockStatement,
  MALFORMED_SAMPLE_MAX,
  type SetRow,
  tallyStatement,
} from "./import-chunks.ts"
import { csvHeaderOf, parseCsv, parseJsonl } from "./parse.ts"

const set = (format: "jsonl" | "csv"): SetRow => ({
  id: "set-1",
  name: "test",
  format,
  sourceFile: "test",
  state: "importing",
  rowCount: 0,
  malformedCount: 0,
  malformedSample: [],
  sensitiveFields: [],
  createdAt: "2026-08-30T00:00:00Z",
})

describe("parseJsonl", () => {
  it("parses one object per line", () => {
    const r = parseJsonl('{"a":1}\n{"a":2}')
    assert.equal(r.records.length, 2)
    assert.deepEqual(r.records[0], { a: 1 })
  })

  it("skips blank lines", () => {
    const r = parseJsonl('{"a":1}\n\n{"a":2}\n')
    assert.equal(r.records.length, 2)
    assert.equal(r.malformed.length, 0)
  })

  it("counts a malformed line and keeps going", () => {
    const r = parseJsonl('{"a":1}\nNOT JSON\n{"a":3}')
    assert.equal(r.records.length, 2)
    assert.deepEqual(r.malformed, [{ line: 2, reason: "invalid JSON" }])
  })

  it("reports line numbers offset by startLine (multi-chunk imports)", () => {
    const r = parseJsonl('BAD\n{"a":1}', 101)
    assert.deepEqual(r.malformed, [{ line: 101, reason: "invalid JSON" }])
  })

  it("refuses lines that are valid JSON but not objects", () => {
    const r = parseJsonl('[1,2,3]\n"just a string"')
    assert.equal(r.records.length, 0)
    assert.equal(r.malformed.length, 2)
  })
})

describe("parseCsv", () => {
  it("uses the header row for field names", () => {
    const r = parseCsv("name,city\nIoana,Timisoara\nDan,Iasi")
    assert.equal(r.records.length, 2)
    assert.deepEqual(r.records[0], { name: "Ioana", city: "Timisoara" })
  })

  it("handles quoted commas, doubled quotes and newlines inside quotes", () => {
    const r = parseCsv('name,note\n"Io,ana","said ""hi"" two\nlines"')
    assert.equal(r.records.length, 1)
    assert.deepEqual(r.records[0], { name: "Io,ana", note: 'said "hi" two\nlines' })
  })

  it("counts a wrong-column row with its own line number", () => {
    const r = parseCsv("a,b\n1,2\n3\n4,5", 1)
    assert.equal(r.records.length, 2)
    assert.deepEqual(r.malformed, [{ line: 3, reason: "1 columns, header has 2" }])
  })

  it("refuses an empty file with a counted line", () => {
    const r = parseCsv("")
    assert.equal(r.records.length, 0)
    assert.equal(r.malformed.length, 1)
  })

  it("de-duplicates repeated header names with a suffix instead of losing a column", () => {
    const r = parseCsv("a,a\n1,2")
    assert.equal(r.records.length, 1)
    assert.deepEqual(r.records[0], { a: "1", a_2: "2" })
  })

  it("parses data rows against a stored header (multi-chunk imports)", () => {
    const r = parseCsv("Dan,Iasi,0722111222\nMaria,Cluj,0722111333\n", 101, ["name", "city", "phone"])
    assert.equal(r.malformed.length, 0)
    assert.deepEqual(r.records, [
      { name: "Dan", city: "Iasi", phone: "0722111222" },
      { name: "Maria", city: "Cluj", phone: "0722111333" },
    ])
  })

  it("stays linear: a large chunk parses fast (the old code was quadratic)", () => {
    const big = Array.from({ length: 20_000 }, (_, i) => `${i},name ${i}`).join("\n")
    const t0 = performance.now()
    const r = parseCsv(`n,note\n${big}`)
    const ms = performance.now() - t0
    assert.equal(r.records.length, 20_000)
    assert.ok(ms < 1000, `parsing took ${ms} ms -- quadratic regression`)
  })

  it("refuses a line with a NUL escape instead of handing jsonb a 500", () => {
    const r = parseJsonl('{"a":"x\\u0000y"}')
    assert.equal(r.records.length, 0)
    assert.deepEqual(r.malformed, [{ line: 1, reason: "contains a NUL character, not storable as jsonb" }])
  })
})

describe("import chunking", () => {
  it("one chunk of JSONL produces a lock, insert statements and a tally update", () => {
    const applied = applyChunk(set("jsonl"), '{"a":1}\n{"a":2}\nBAD', 1)
    assert.equal(applied.parsed, 2)
    assert.equal(applied.malformed.length, 1)
    // Advisory lock, one 500-row INSERT, then the tally statement.
    assert.equal(applied.statements.length, 3)
    assert.match(applied.statements[0]?.text ?? "", /pg_advisory_xact_lock/)
    assert.match(applied.statements[1]?.text ?? "", /INSERT INTO "rows"/)
    assert.match(applied.statements[applied.statements.length - 1]?.text ?? "", /UPDATE "sets"/)
  })

  it("row numbers are computed IN the batch from the live row count, not a stale read", () => {
    const applied = applyChunk({ ...set("jsonl"), rowCount: 10 }, '{"a":1}', 1)
    const stmt = applied.statements[1] as { text: string }
    // The base comes from count(*) over the set's rows inside the same transaction as the
    // insert -- the set's own rowCount is never trusted for numbering.
    assert.match(stmt.text, /count\(\*\)::int AS n FROM "rows" WHERE body->>'setId'/)
    assert.match(stmt.text, /base\.n \+ x\.rn/)
  })

  it("a non-first CSV chunk is parsed against the header stored on the set", () => {
    const s = { ...set("csv"), rowCount: 3, csvHeader: ["name", "city"] }
    const applied = applyChunk(s, "Dan,Iasi", 4)
    assert.equal(applied.parsed, 1)
    assert.equal(applied.malformed.length, 0)
    // No new header is stored on later chunks.
    const tally = applied.statements[applied.statements.length - 1] as { values?: ReadonlyArray<unknown> }
    assert.equal(tally.values?.length, 4)
  })

  it("the first CSV chunk stores its header on the set", () => {
    const applied = applyChunk(set("csv"), "name,city\nDan,Iasi", 1)
    const tally = applied.statements[applied.statements.length - 1] as { values?: ReadonlyArray<unknown> }
    assert.equal(csvHeaderOf("name,city\nDan,Iasi").join(","), "name,city")
    assert.equal(tally.values?.[4], '["name","city"]')
  })

  it("the malformed sample is capped in SQL against the live row", () => {
    const tally = tallyStatement(
      "set-1",
      1,
      25,
      Array.from({ length: 25 }, (_, i) => ({ line: i + 1, reason: "x" })),
    )
    assert.match(tally.text, new RegExp(`\\[1:${MALFORMED_SAMPLE_MAX}\\]`))
    // The full fresh sample travels as a value; the slice, not the caller, does the capping.
    const sampleValue = tally.values?.[3] as string | undefined
    assert.equal((sampleValue ?? "").length > 0, true)
  })

  it("insertRowsStatement batches 500 rows per INSERT", () => {
    const records = Array.from({ length: 501 }, (_, i) => ({ a: i }))
    const statements = insertRowsStatement(records, "set-1")
    assert.equal(statements.length, 2)
  })

  it("chunks on one set serialise behind a transaction advisory lock", () => {
    const lock = lockStatement("set-1")
    assert.match(lock.text, /pg_advisory_xact_lock\(hashtext\(\$1\)\)/)
    assert.deepEqual(lock.values, ["set-1"])
  })
})
