// Unit tests for the QWB-46 custom-value transport (runtime-composition.ts).
//
// The storage decision of 2026-08-30: custom-field values live in `jsonb` in the target row,
// under one reserved sub-object (`custom`) -- not in a sidecar table. These tests pin the pure
// parts of that policy: declared fields keep their validation, undeclared keys survive decode
// and fold into `custom`, and the fold never touches what a cube declared.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Schema } from "effect"
import { CUSTOM, declaredKeys, foldCustom, widenStruct } from "./runtime-composition.ts"

const Contact = Schema.Struct({
  name: Schema.String,
  email: Schema.optionalWith(Schema.String, { default: () => "" }),
})

describe("custom-value transport", () => {
  it("widened decode keeps undeclared keys alongside the declared ones", () => {
    const decode = Schema.decodeUnknownSync(widenStruct(Contact) as Schema.Schema<Record<string, unknown>>)
    const row = decode({ name: "Test", cnp: "123" })
    assert.equal(row.name, "Test")
    assert.equal(row.cnp, "123")
  })

  it("widened decode still applies declared defaults", () => {
    const decode = Schema.decodeUnknownSync(widenStruct(Contact) as Schema.Schema<Record<string, unknown>>)
    assert.equal(decode({ name: "T" }).email, "")
  })

  it("widened decode still refuses a bad declared field", () => {
    const decode = Schema.decodeUnknownSync(widenStruct(Contact) as Schema.Schema<Record<string, unknown>>)
    assert.throws(() => decode({ name: 7 }))
  })

  it("declaredKeys reports exactly the declared properties, not the index signature", () => {
    assert.deepEqual([...declaredKeys(widenStruct(Contact))].sort(), ["email", "name"])
  })

  it("foldCustom moves undeclared keys under the reserved sub-object", () => {
    const folded = foldCustom({ name: "Test", cnp: "123", extra: true }, ["name", "email"])
    assert.deepEqual(folded, { name: "Test", [CUSTOM]: { cnp: "123", extra: true } })
  })

  it("foldCustom merges an explicit custom object with undeclared keys", () => {
    const folded = foldCustom({ name: "T", [CUSTOM]: { a: "1" }, b: "2" }, ["name"])
    assert.deepEqual(folded, { name: "T", [CUSTOM]: { a: "1", b: "2" } })
  })

  it("foldCustom leaves a payload with nothing undeclared untouched (same reference)", () => {
    const payload = { name: "T", email: "e@x.y" }
    assert.equal(foldCustom(payload, ["name", "email"]), payload)
  })

  it("widened encode keeps the custom sub-object in the response", () => {
    const encode = Schema.encodeSync(widenStruct(Contact) as Schema.Schema<Record<string, unknown>>)
    const out = encode({ name: "T", email: "e@x.y", [CUSTOM]: { cnp: "123" } })
    assert.deepEqual(out[CUSTOM], { cnp: "123" })
  })

  it("widened encode keeps undeclared flat keys too (the row round-trip shape)", () => {
    const encode = Schema.encodeSync(widenStruct(Contact) as Schema.Schema<Record<string, unknown>>)
    const out = encode({ name: "T", email: "e@x.y", cnp: "9" })
    assert.equal(out.cnp, "9")
  })

  it("a non-struct schema passes through unwidened", () => {
    const arr = Schema.Array(Schema.String)
    assert.equal(widenStruct(arr), arr)
  })
})
