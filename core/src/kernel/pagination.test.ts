// Unit tests for the page contract. No server, no database, no filesystem.
//
// `pageRequest` is where the hostile query string stops. Every case below is one that reached
// SQLite in an earlier iteration and came back as an empty HTTP 500 — the comments in
// pagination.ts name them; these tests make the names executable.

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { DEFAULT_LIMIT, MAX_LIMIT, pageRequest } from "./pagination.ts"

describe("pageRequest — defaults", () => {
  it("with no argument gives the first page at the default size", () => {
    assert.deepEqual(pageRequest(), {
      offset: 0,
      limit: DEFAULT_LIMIT,
      sortBy: undefined,
      descending: false,
    })
  })

  it("keeps a request that is already valid", () => {
    assert.deepEqual(pageRequest({ offset: 50, limit: 10, sortBy: "createdAt", descending: true }), {
      offset: 50,
      limit: 10,
      sortBy: "createdAt",
      descending: true,
    })
  })
})

describe("pageRequest — the limit is capped hard", () => {
  it("caps ?limit=999999 at MAX_LIMIT", () => {
    assert.equal(pageRequest({ limit: 999_999 }).limit, MAX_LIMIT)
  })

  it("raises a limit below one to one", () => {
    assert.equal(pageRequest({ limit: 0 }).limit, 1)
    assert.equal(pageRequest({ limit: -10 }).limit, 1)
  })

  it("truncates a fractional limit instead of binding a float", () => {
    assert.equal(pageRequest({ limit: 10.9 }).limit, 10)
  })
})

describe("pageRequest — offset is never negative", () => {
  it("clamps a negative offset to zero", () => {
    assert.equal(pageRequest({ offset: -5 }).offset, 0)
  })

  it("truncates a fractional offset", () => {
    assert.equal(pageRequest({ offset: 3.7 }).offset, 3)
  })
})

// The 500s that got through. NaN and Infinity survive Math.trunc; 1e20 is finite and still
// larger than the 64-bit integer SQLite will bind. Both came back as `datatype mismatch`.
describe("pageRequest — numbers that are not usable numbers", () => {
  it("falls back to zero on NaN offset", () => {
    assert.equal(pageRequest({ offset: Number.NaN }).offset, 0)
  })

  it("falls back to the default on NaN limit", () => {
    assert.equal(pageRequest({ limit: Number.NaN }).limit, DEFAULT_LIMIT)
  })

  // Note the asymmetry with the cap: an infinite limit is not "as big as possible", it is not a
  // number at all, so it takes the default. Only a finite 999999 gets clamped to MAX_LIMIT.
  it("falls back on Infinity rather than passing it down", () => {
    assert.equal(pageRequest({ offset: Number.POSITIVE_INFINITY }).offset, 0)
    assert.equal(pageRequest({ offset: Number.NEGATIVE_INFINITY }).offset, 0)
    assert.equal(pageRequest({ limit: Number.POSITIVE_INFINITY }).limit, DEFAULT_LIMIT)
    assert.equal(pageRequest({ limit: Number.NEGATIVE_INFINITY }).limit, DEFAULT_LIMIT)
  })

  it("clamps a finite-but-enormous offset into the safe-integer range", () => {
    const offset = pageRequest({ offset: 1e20 }).offset
    assert.equal(offset, Number.MAX_SAFE_INTEGER)
    assert.ok(Number.isSafeInteger(offset), "the bound value must be a safe integer")
  })
})

// Belt and braces: the schema rejects a malformed field at the HTTP door, but cube code calls
// this function directly, where nothing has been through the schema.
describe("pageRequest — sortBy must be a plain identifier", () => {
  it("keeps a plain field name", () => {
    assert.equal(pageRequest({ sortBy: "created_at" }).sortBy, "created_at")
    assert.equal(pageRequest({ sortBy: "_private9" }).sortBy, "_private9")
  })

  it("drops a field that would break the JSON path", () => {
    for (const bad of ['"', "[0]", "a.b", "a b", "a-b", "1abc", "", "title; drop table notes"]) {
      assert.equal(pageRequest({ sortBy: bad }).sortBy, undefined, `sortBy ${JSON.stringify(bad)} must be dropped`)
    }
  })
})

describe("pageRequest — descending", () => {
  it("defaults to ascending", () => {
    assert.equal(pageRequest({}).descending, false)
  })

  it("passes an explicit false through instead of turning it into the default", () => {
    assert.equal(pageRequest({ descending: false }).descending, false)
  })
})
