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
import { declaredKeys, isStructSchema, widenStruct } from "./runtime-composition.ts"

const Contact = Schema.Struct({
  name: Schema.String,
  email: Schema.optionalWith(Schema.String, { default: () => "" }),
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
})
