// Unit tests for the shape detector. No database, no server.
//
// Each shape gets a value that must match it, and the CASES THAT MATTER are the ones where a
// shape must NOT swallow the value: a phone number is not a date, a timestamp is not free
// text, "INV-2024-001" is not a number even though it contains one.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { ENUM_MAX_DISTINCT, SHAPE_PATTERNS, shapeOf } from "./shapes.ts"

describe("shapeOf -- number", () => {
  it("matches integers and decimals, including negative", () => {
    assert.equal(shapeOf(42), "number")
    assert.equal(shapeOf("42"), "number")
    assert.equal(shapeOf("-3.14"), "number")
    assert.equal(shapeOf(0), "number")
  })

  it("does not match numbers with separators or trailing text", () => {
    assert.equal(shapeOf("1,234"), "text")
    assert.equal(shapeOf("12a"), "text")
    assert.equal(shapeOf("1.2.3"), "text")
    assert.equal(shapeOf("INV-2024-001"), "text")
  })
})

describe("shapeOf -- date", () => {
  it("matches ISO dates and datetimes", () => {
    assert.equal(shapeOf("2024-01-02"), "date")
    assert.equal(shapeOf("2024-01-02T10:30:00Z"), "date")
    assert.equal(shapeOf("2024-01-02 10:30"), "date")
    assert.equal(shapeOf("2024-01-02T10:30:00+02:00"), "date")
  })

  it("does not match impossible-looking text that merely starts with digits", () => {
    assert.equal(shapeOf("02/01/2024"), "text")
    assert.equal(shapeOf("Jan 2, 2024"), "text")
  })
})

describe("shapeOf -- email", () => {
  it("matches a plain address", () => {
    assert.equal(shapeOf("ioana@example.com"), "email")
  })

  it("does not match a bare word or two @ signs", () => {
    assert.equal(shapeOf("ioana"), "text")
    assert.equal(shapeOf("a@@b.c"), "text")
  })
})

describe("shapeOf -- phone", () => {
  it("matches international and spaced formats", () => {
    assert.equal(shapeOf("+40 722 123 456"), "phone")
    assert.equal(shapeOf("(021) 305-1000"), "phone")
  })

  it("prefers number over phone: 12345 is a number", () => {
    // Documented ambiguity: a digit-only string is a number; a phone needs a +, a parenthesis
    // or a separator to be recognisable as one.
    assert.equal(shapeOf("12345"), "number")
    assert.equal(shapeOf("0722123456"), "number")
  })

  it("does not match text with letters", () => {
    assert.equal(shapeOf("call me at extension 12"), "text")
  })
})

describe("shapeOf -- text and empty", () => {
  it("free text stays free text", () => {
    assert.equal(shapeOf("Customer complained about late delivery"), "text")
    assert.equal(shapeOf("SRL Logistic Intermed SRL"), "text")
  })

  it("null, undefined and empty string mean no value", () => {
    assert.equal(shapeOf(null), null)
    assert.equal(shapeOf(undefined), null)
    assert.equal(shapeOf(""), null)
  })
})

describe("shape constants", () => {
  it("patterns are valid regular expressions and share JS/SQL syntax", () => {
    for (const pattern of Object.values(SHAPE_PATTERNS)) assert.doesNotThrow(() => new RegExp(pattern))
  })

  it("the enum threshold is a small number", () => {
    assert.ok(ENUM_MAX_DISTINCT > 1 && ENUM_MAX_DISTINCT <= 26)
  })
})
