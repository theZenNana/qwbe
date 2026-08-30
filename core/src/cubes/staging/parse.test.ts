// Unit tests for the import parsers and the malformed-line counting. The rule under test:
// a malformed line is COUNTED and reported with its ABSOLUTE line number, and the import
// continues -- one bad line never costs the good ones around it.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { applyChunk, capSample, MALFORMED_SAMPLE_MAX, type SetRow } from "./import-chunks.ts"
import { parseCsv, parseJsonl } from "./parse.ts"

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
})

describe("import chunking", () => {
  it("one chunk of JSONL produces insert statements and a tally update", () => {
    const applied = applyChunk(set("jsonl"), '{"a":1}\n{"a":2}\nBAD', 1)
    assert.equal(applied.parsed, 2)
    assert.equal(applied.malformed.length, 1)
    // 500-row insert batches: 2 records fit in one INSERT, then the tally statement.
    assert.equal(applied.statements.length, 2)
    assert.match(applied.statements[0]?.text ?? "", /INSERT INTO "rows"/)
    assert.match(applied.statements[applied.statements.length - 1]?.text ?? "", /UPDATE "sets"/)
  })

  it("row numbers continue from the set's existing rows", () => {
    const s = { ...set("jsonl"), rowCount: 10 }
    const applied = applyChunk(s, '{"a":1}', 1)
    const stmt = (applied.statements[0] ?? {}) as { values?: ReadonlyArray<unknown> }
    const body = JSON.stringify(stmt.values?.[5])
    assert.match(body, /"rowNum":11/)
  })

  it("the stored malformed sample is capped, the counts are not", () => {
    const full = Array.from({ length: MALFORMED_SAMPLE_MAX }, (_, i) => ({ line: i + 1, reason: "invalid JSON" }))
    assert.deepEqual(capSample([], full).length, MALFORMED_SAMPLE_MAX, "a first chunk may fill the whole sample")
    assert.deepEqual(capSample(full, [{ line: 99, reason: "invalid JSON" }]), [], "a full sample takes nothing more")
  })
})
