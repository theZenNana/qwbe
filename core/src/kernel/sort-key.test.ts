// sortKey (Qwbe#73): plain `<` on two keys must agree with the intended order of their values.

import assert from "node:assert/strict"
import { DateTime, FastCheck as fc } from "effect"
import { describe, it } from "vitest"
import { foldText, SORT_KEY_VERSION, sortKey, sortKeysFor, withSortKeys } from "./sort-key.ts"

const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0)
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const HEX = /^[0-3][0-9a-f]*$/

describe("sortKey", () => {
  it("orders numbers numerically, -0 equal to 0", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true }), fc.double({ noNaN: true }), (a, b) => {
        assert.equal(cmp(sortKey(a), sortKey(b)), sign(a - b || 0))
      }),
    )
    assert.equal(sortKey(-0), sortKey(0))
    assert.ok(sortKey(9) < sortKey(10))
    assert.ok(sortKey(-10) < sortKey(-9))
  })

  it("orders strings by their folded text within the first 32 bytes", () => {
    const bytes = (s: string) => Buffer.from(foldText(s)).subarray(0, 32)
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), fc.string({ unit: "grapheme" }), (a, b) => {
        assert.equal(cmp(sortKey(a), sortKey(b)), sign(Buffer.compare(bytes(a), bytes(b))))
      }),
    )
    assert.equal(sortKey("\u00c9lan"), sortKey("elan"))
    assert.equal(sortKey("\u015eTEFAN"), sortKey("stefan"))
    assert.ok(sortKey("apple") < sortKey("Banana"))
  })

  it("never interleaves types: null < boolean < number < string", () => {
    const ordered = [null, false, true, -1e308, 0, 1e308, "", "a"].map(sortKey)
    assert.deepEqual([...ordered].sort(), ordered)
    fc.assert(fc.property(fc.jsonValue(), (v) => assert.match(sortKey(v), HEX)))
  })

  it("sorts ISO timestamps in time order: formatIso is fixed-width UTC", () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date("0001-01-01"), max: new Date("9999-12-31"), noInvalidDate: true }),
        fc.date({ min: new Date("0001-01-01"), max: new Date("9999-12-31"), noInvalidDate: true }),
        (a, b) => {
          const iso = (d: Date) => DateTime.formatIso(DateTime.unsafeMake(d))
          assert.equal(iso(a).length, 24)
          assert.equal(cmp(sortKey(iso(a)), sortKey(iso(b))), sign(a.getTime() - b.getTime()))
        },
      ),
    )
  })
})

describe("sortKeysFor", () => {
  it("keys only the sortable fields the body carries, under the version", () => {
    assert.deepEqual(sortKeysFor({ name: "a", size: 2, other: "x" }, ["name", "size", "missing"]), {
      v: SORT_KEY_VERSION,
      k: { name: sortKey("a"), size: sortKey(2) },
    })
    assert.equal(sortKeysFor({ other: "x" }, ["name"]), undefined)
  })

  it("replaces a caller-supplied _sort and drops it when nothing is sortable", () => {
    assert.deepEqual(withSortKeys({ name: "a", _sort: "forged" }, ["name"]), {
      name: "a",
      _sort: { v: SORT_KEY_VERSION, k: { name: sortKey("a") } },
    })
    assert.deepEqual(withSortKeys({ other: 1, _sort: "forged" }, ["name"]), { other: 1 })
  })
})
