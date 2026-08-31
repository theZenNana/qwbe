// Unit tests for the QWB-46 custom-value transport (runtime-composition.ts + custom-values.ts).
//
// The storage decision of 2026-08-30: custom-field values live in `jsonb` in the target row,
// under one reserved sub-object (`custom`) -- not in a sidecar table. These tests pin the pure
// parts of that policy: declared fields keep their validation, undeclared keys survive decode
// and fold into `custom` ONLY against active definitions, and the fold never touches what a
// cube declared. Review fixes are pinned here too: the definition gate (1), per-type validation
// on the real write path (2), the size caps (3), non-struct schemas skip the fold (7), the
// declared-`custom` field (14), and prototype-smuggling keys (15).

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Schema } from "effect"
import { CUSTOM, checkCustomValue, foldCustom, MAX_CUSTOM_KEYS } from "./custom-values.ts"
import { PageOf } from "./http-contracts.ts"
import { declaredKeys, isStructSchema, widenStruct } from "./runtime-composition.ts"

const Contact = Schema.Struct({
  name: Schema.String,
  email: Schema.optionalWith(Schema.String, { default: () => "" }),
})

const Note = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  createdAt: Schema.String,
  deleted: Schema.Boolean,
  title: Schema.String,
})

type ListEnvelope = { rows: ReadonlyArray<Record<string, unknown>>; total: number }

const envelopeOf = <A, I, R>(row: Schema.Schema<A, I, R>) =>
  widenStruct(PageOf(row), "success") as Schema.Schema<ListEnvelope>

const page = (rows: ReadonlyArray<Record<string, unknown>>) => ({
  rows,
  total: rows.length,
  offset: 0,
  limit: 25,
  sortedBy: "",
})

const textDef = { name: "cnp", fieldType: "text" as const, required: false, options: [] }
const numberDef = { name: "age", fieldType: "number" as const, required: false, options: [] }

describe("custom-value transport", () => {
  it("widened decode keeps undeclared keys alongside the declared ones", () => {
    const decode = Schema.decodeUnknownSync(widenStruct(Contact, "payload") as Schema.Schema<Record<string, unknown>>)
    const row = decode({ name: "Test", cnp: "123" })
    assert.equal(row.name, "Test")
    assert.equal(row.cnp, "123")
  })

  it("widened decode still applies declared defaults", () => {
    const decode = Schema.decodeUnknownSync(widenStruct(Contact, "payload") as Schema.Schema<Record<string, unknown>>)
    assert.equal(decode({ name: "T" }).email, "")
  })

  it("widened decode still refuses a bad declared field", () => {
    const decode = Schema.decodeUnknownSync(widenStruct(Contact, "payload") as Schema.Schema<Record<string, unknown>>)
    assert.throws(() => decode({ name: 7 }))
  })

  it("declaredKeys reports exactly the declared properties, not the index signature", () => {
    assert.deepEqual([...declaredKeys(widenStruct(Contact, "payload"))].sort(), ["email", "name"])
  })

  it("with no active definitions the fold strips undeclared keys (the definition gate)", () => {
    const folded = foldCustom({ name: "Test", cnp: "123" }, ["name", "email"], [])
    assert.deepEqual(folded, { ok: true, payload: { name: "Test" } })
  })

  it("a key with no definition is rejected, never stored", () => {
    const folded = foldCustom({ name: "T", ghost: "x" }, ["name"], [textDef])
    assert.equal(folded.ok, false)
    assert.match(folded.ok ? "" : folded.message, /ghost/)
  })

  it("foldCustom moves defined undeclared keys under the reserved sub-object", () => {
    const folded = foldCustom({ name: "Test", cnp: "123", email: "e@x.y" }, ["name", "email"], [textDef])
    assert.deepEqual(folded, { ok: true, payload: { name: "Test", email: "e@x.y", [CUSTOM]: { cnp: "123" } } })
  })

  it("a value that breaks its definition is rejected on the write path", () => {
    const folded = foldCustom({ name: "T", age: { nested: 1 } }, ["name"], [numberDef])
    assert.equal(folded.ok, false)
    assert.match(folded.ok ? "" : folded.message, /age/)
  })

  it("checkCustomValue mirrors the definition types", () => {
    assert.equal(checkCustomValue(numberDef, "42"), undefined)
    assert.equal(checkCustomValue(numberDef, 42), undefined)
    assert.notEqual(checkCustomValue(numberDef, "abc"), undefined)
    const selectDef = { name: "s", fieldType: "select" as const, required: false, options: ["a", "b"] }
    assert.equal(checkCustomValue(selectDef, "a"), undefined)
    assert.notEqual(checkCustomValue(selectDef, "c"), undefined)
  })

  it("the caps refuse an oversized custom object", () => {
    const big = Object.fromEntries(Array.from({ length: MAX_CUSTOM_KEYS + 1 }, (_, i) => [`f${i}`, "x"]))
    const folded = foldCustom(
      { name: "T", ...big },
      ["name"],
      [
        ...Array.from({ length: MAX_CUSTOM_KEYS + 1 }, (_, i) => ({
          name: `f${i}`,
          fieldType: "text" as const,
          required: false,
          options: [],
        })),
      ],
    )
    assert.equal(folded.ok, false)
    assert.match(folded.ok ? "" : folded.message, /cap/)
    const defs = Array.from({ length: 10 }, (_, i) => ({
      name: `blob${i}`,
      fieldType: "text" as const,
      required: false,
      options: [],
    }))
    const wide = { name: "T", ...Object.fromEntries(defs.map((d) => [d.name, "x".repeat(900)])) }
    const tooBig = foldCustom(wide, ["name"], defs)
    assert.equal(tooBig.ok, false)
    assert.match(tooBig.ok ? "" : tooBig.message, /bytes/)
  })

  it("a field literally named custom stays a declared field, and the fold still strips others", () => {
    const folded = foldCustom({ name: "T", [CUSTOM]: "mine", ghost: 1 }, ["name", CUSTOM], [textDef])
    assert.deepEqual(folded, { ok: true, payload: { name: "T", [CUSTOM]: "mine" } })
  })

  it("prototype-smuggling keys are refused, not silently dropped", () => {
    // JSON.parse gives a REAL own `__proto__` property -- an object literal would set the
    // prototype instead, which is exactly why the own-property path must be guarded.
    const smuggled = JSON.parse('{"name":"T","__proto__":{"x":1}}') as Record<string, unknown>
    const folded = foldCustom(smuggled, ["name"], [textDef])
    assert.equal(folded.ok, false)
  })

  it("a non-struct schema passes through unwidened and skips the fold", () => {
    const arr = Schema.Array(Schema.String)
    assert.equal(widenStruct(arr, "payload"), arr)
    assert.equal(isStructSchema(arr), false)
  })

  it("a filtered struct is not widened and reports as not a struct (the skip rule)", () => {
    const filtered = Schema.Struct({ name: Schema.String }).pipe(Schema.filter(() => true))
    assert.equal(isStructSchema(filtered), false)
  })

  it("the success widening emits custom only under the declared sub-object", () => {
    const encode = Schema.encodeSync(widenStruct(Contact, "success") as Schema.Schema<Record<string, unknown>>)
    const out = encode({ name: "T", email: "e@x.y", cnp: "9", [CUSTOM]: { cnp: "9" } })
    assert.equal(out.cnp, undefined)
    assert.deepEqual(out[CUSTOM], { cnp: "9" })
  })

  // QWB-54 ticket 16: a list success is the ENVELOPE {rows, ...}, so a widening that stops at
  // the top level declares `custom` on the envelope while Effect strips it from every row.
  describe("list envelopes (the widening reaches the rows)", () => {
    it("a row inside {rows} keeps its custom values on encode", () => {
      const encode = Schema.encodeUnknownSync(envelopeOf(Note))
      const out = encode(
        page([{ id: "1", type: "Note", createdAt: "t", deleted: false, title: "T", [CUSTOM]: { cnp: "123" } }]),
      )
      const row = out.rows[0] as Record<string, unknown>
      assert.deepEqual(row[CUSTOM], { cnp: "123" })
      assert.equal(row.title, "T")
    })

    it("a widened row still strips undeclared keys outside custom (the invariant holds per row)", () => {
      const encode = Schema.encodeUnknownSync(envelopeOf(Note))
      const out = encode(
        page([
          { id: "1", type: "Note", createdAt: "t", deleted: false, title: "T", ghost: "x", [CUSTOM]: { cnp: "123" } },
        ]),
      )
      const row = out.rows[0] as Record<string, unknown>
      assert.equal(row.ghost, undefined)
      assert.deepEqual(row[CUSTOM], { cnp: "123" })
    })

    it("rows carrying optionalWith defaults keep their transformation and their custom values", () => {
      const Row = Schema.Struct({
        id: Schema.String,
        body: Schema.optionalWith(Schema.String, { default: () => "" }),
      })
      const schema = envelopeOf(Row)
      const encode = Schema.encodeUnknownSync(schema)
      const out = encode(page([{ id: "1", body: "b", [CUSTOM]: { cnp: "9" } }]))
      const row = out.rows[0] as Record<string, unknown>
      assert.equal(row.body, "b")
      assert.deepEqual(row[CUSTOM], { cnp: "9" })
      // The default is a decode-side concern (the type side requires the field); it must survive
      // the widening untouched.
      const decoded = Schema.decodeUnknownSync(schema)(page([{ id: "2" }]))
      assert.equal(decoded.rows[0]?.body, "")
    })

    it("a rows property that is not an array of structs passes through untouched", () => {
      const Weird = Schema.Struct({ rows: Schema.Array(Schema.String), total: Schema.Number })
      const widened = widenStruct(Weird, "success") as {
        ast: { propertySignatures: ReadonlyArray<{ name: PropertyKey; type: unknown }> }
      }
      const before = (Weird.ast as { propertySignatures: ReadonlyArray<{ name: PropertyKey; type: unknown }> })
        .propertySignatures
      const after = widened.ast.propertySignatures
      const rowsBefore = before.find((p) => p.name === "rows")
      const rowsAfter = after.find((p) => p.name === "rows")
      assert.deepEqual(rowsAfter?.type, rowsBefore?.type)
    })
  })
})
