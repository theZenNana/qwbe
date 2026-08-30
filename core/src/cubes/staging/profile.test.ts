// Unit tests for the profile aggregation with a STUB store -- no Postgres here.
//
// aggregateField is where SQL buckets become a response field; everything around it (which
// statements run, in what order) is exercised by the probe. What a stub can prove:
// bucket merging, the enum-vs-text decision, the fill rate, and that a sensitive field
// carries NO examples -- not fewer, none.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { aggregateField, type FieldStats, fieldStats, fieldTop } from "./profile.ts"
import { SHAPE_PATTERNS } from "./shapes.ts"

const stats = (over: Partial<FieldStats> = {}): FieldStats => ({
  filled: 0,
  distinct_values: 0,
  other_distinct: 0,
  number_count: 0,
  date_count: 0,
  email_count: 0,
  phone_count: 0,
  ...over,
})

describe("aggregateField", () => {
  it("reports the specific shapes and their counts", () => {
    const p = aggregateField(
      "phone_field",
      stats({ filled: 10, distinct_values: 7, phone_count: 8, number_count: 2 }),
      10,
      [],
    )
    assert.deepEqual(p.shapes, [
      { shape: "number", count: 2 },
      { shape: "phone", count: 8 },
    ])
  })

  it("fill rate is a percentage of the set's total rows", () => {
    const p = aggregateField("f", stats({ filled: 75 }), 100, [])
    assert.equal(p.fillRate, 75)
    const q = aggregateField("f", stats({ filled: 1 }), 3, [])
    assert.equal(q.fillRate, 33.3)
  })

  it("an empty set has a 0 fill rate, not a division by zero", () => {
    const p = aggregateField("f", stats(), 0, [])
    assert.equal(p.fillRate, 0)
  })

  it("few distinct leftovers are a small enum, many are free text", () => {
    const e = aggregateField("f", stats({ filled: 5, distinct_values: 3, other_distinct: 3 }), 10, [])
    assert.equal(enumShapeOf(e.shapes), "enum")
    const big = aggregateField("f", stats({ filled: 500, distinct_values: 400, other_distinct: 400 }), 1000, [])
    assert.equal(enumShapeOf(big.shapes), "text")
  })

  it("the enum decision reads the LEFTOVER distinct count, not the whole field", () => {
    // 3 distinct numbers + 2 free-text values: the whole-field count is 5 (would read enum on
    // some thresholds), but the leftover bucket has 2 distinct values -- still an enum, and
    // with 20 leftovers it is text even though the field total stays small.
    const few = aggregateField("f", stats({ filled: 5, distinct_values: 5, other_distinct: 2 }), 10, [])
    assert.equal(enumShapeOf(few.shapes), "enum")
    const many = aggregateField("f", stats({ filled: 25, distinct_values: 25, other_distinct: 20 }), 100, [])
    assert.equal(enumShapeOf(many.shapes), "text")
  })

  it("top values are truncated to the masking limit", () => {
    const p = aggregateField("f", stats({ filled: 1 }), 1, [{ value: "x".repeat(500), count: 1 }])
    assert.equal((p.top?.[0]?.value ?? "").length <= 40, true, "no whole value may leave the profile")
  })

  it("a sensitive field returns NO example values -- passing no top omits the key entirely", () => {
    const p = aggregateField("email", stats({ filled: 3, distinct_values: 3 }), 3, undefined)
    assert.equal("top" in p, false, "sensitive field must not even have a top key")
    const q = aggregateField("f", stats({ filled: 1 }), 1, [{ value: "x", count: 1 }])
    assert.deepEqual(q.top, [{ value: "x", count: 1 }])
  })

  it("top values keep their counts as numbers", () => {
    const p = aggregateField("f", stats({ filled: 4 }), 4, [
      { value: "Timisoara", count: 3 },
      { value: "Iasi", count: 1 },
    ])
    assert.equal(p.top?.[0]?.count, 3)
  })
})

describe("profile statements", () => {
  const setId = "set-abc"

  it("bind field names and set ids as parameters, never into the SQL text", () => {
    const stats = fieldStats("phone", setId)
    assert.equal(stats.values?.[0], "phone")
    assert.equal(stats.values?.[5], setId)
    assert.ok(!stats.text.includes("'phone'"))
    const top = fieldTop("phone", setId)
    assert.equal(top.values?.[0], "phone")
    assert.ok(!top.text.includes("'phone'"))
  })

  it("carry the same shape patterns as the JS detector", () => {
    const stats = fieldStats("f", setId)
    assert.equal(stats.values?.[1], SHAPE_PATTERNS.number)
  })
})

// helper: the shape of the leftover bucket (enum or free text)
function enumShapeOf(shapes: ReadonlyArray<{ shape: string; count: number }>): string {
  const leftover = shapes.filter((s) => s.shape === "enum" || s.shape === "text")
  return leftover.map((s) => s.shape).join(",") ?? ""
}
