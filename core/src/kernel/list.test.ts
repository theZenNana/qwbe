// The generic list (QWB-54): the query contract, and the SQL it becomes.
//
// Everything here is pure -- no server, no database. The runtime half, on a large table, is
// `probes/list.mjs`.

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { whereClause } from "../pg/rows.ts"
import { listPageRequest, listWhere } from "./list.ts"
import { MAX_LIMIT } from "./pagination.ts"

// What the schema hands the handler when the caller sends nothing: two defaults, no more.
// What the schema hands the handler: nothing it was not given. No defaults -- that is the
// point of ListParams, and what lets "asked for 25" differ from "said nothing".
const params = (over: Record<string, unknown> = {}) => over as never

const manifest = {
  searchable: ["name", "email"],
  relations: { accountId: { target: "crm/accounts" } },
} as const

describe("the list query contract", () => {
  it("turns page and pageSize into offset and limit", () => {
    const p = listPageRequest(params({ page: 3, pageSize: 10 }))
    assert.equal(p.offset, 20)
    assert.equal(p.limit, 10)
  })

  it("treats page 1 as the first page, not the second", () => {
    assert.equal(listPageRequest(params({ page: 1, pageSize: 50 })).offset, 0)
  })

  it("caps pageSize at the contract's maximum instead of refusing it", () => {
    assert.equal(listPageRequest(params({ pageSize: 5000 })).limit, MAX_LIMIT)
  })

  it("still honours the older offset and limit spelling", () => {
    const p = listPageRequest(params({ offset: 40, limit: 20, sortBy: "name", descending: true }))
    assert.deepEqual(p, { offset: 40, limit: 20, sortBy: "name", descending: true })
  })

  it("reads sort as field and direction", () => {
    assert.equal(listPageRequest(params({ sort: "name:desc" })).sortBy, "name")
    assert.equal(listPageRequest(params({ sort: "name:desc" })).descending, true)
    assert.equal(listPageRequest(params({ sort: "name" })).descending, false)
  })

  it("sizes an ids batch by the batch, so one request returns exactly the rows asked for", () => {
    const ids = Array.from({ length: 60 }, (_, i) => `c-${i}`).join(",")
    assert.equal(listPageRequest(params({ ids })).limit, 60)
    // A batch bigger than the cap is still capped -- the cap is the contract, not a suggestion.
    const many = Array.from({ length: 500 }, (_, i) => `c-${i}`).join(",")
    assert.equal(listPageRequest(params({ ids: many })).limit, MAX_LIMIT)
    // An explicit size wins over the batch size.
    assert.equal(listPageRequest(params({ ids, pageSize: 5 })).limit, 5)
  })

  it("filters only by fields the manifest declares", () => {
    const where = listWhere(params(), { name: "ada", passwordHash: "x", accountId: "acc-1" }, manifest)
    assert.deepEqual(where?.equals, [
      { field: "accountId", value: "acc-1" },
      { field: "name", value: "ada" },
    ])
  })

  it("searches the searchable fields and no others", () => {
    assert.deepEqual(listWhere(params({ q: "ada" }), {}, manifest)?.q, { text: "ada", fields: ["name", "email"] })
    // Nothing declared searchable means `q` has nothing to scan, so it asks for nothing.
    assert.equal(listWhere(params({ q: "ada" }), {}, {}), undefined)
  })

  it("asks for nothing when the caller filtered by nothing", () => {
    assert.equal(listWhere(params(), {}, manifest), undefined)
  })
})

describe("the SQL a list query becomes", () => {
  it("numbers the parameters of several filters in order", () => {
    const w = whereClause({
      equals: [
        { field: "name", value: "ada" },
        { field: "accountId", value: "acc-1" },
      ],
    })
    assert.equal(w.sql, "AND body ->> $1::text = $2::text AND body ->> $3::text = $4::text")
    assert.deepEqual(w.params, ["name", "ada", "accountId", "acc-1"])
  })

  it("keeps the single-pair shape working, which relational.search still passes", () => {
    assert.deepEqual(whereClause({ field: "bookmarkId", value: "b-1" }), {
      sql: "AND body ->> $1::text = $2::text",
      params: ["bookmarkId", "b-1"],
    })
  })

  it("asks for a batch of ids in ONE bound array, not one parameter each", () => {
    const w = whereClause({ ids: ["a", "b", "c"] })
    assert.equal(w.sql, "AND id = ANY($1::text[])")
    assert.deepEqual(w.params, [["a", "b", "c"]])
  })

  it("makes q a prefix match over every searchable field", () => {
    const w = whereClause({ q: { text: "ad", fields: ["name", "email"] } })
    assert.equal(w.sql, "AND (body ->> $2::text ILIKE $1 OR body ->> $3::text ILIKE $1)")
    assert.deepEqual(w.params, ["ad%", "name", "email"])
  })

  it("does not let a caller's % or _ act as a wildcard", () => {
    assert.deepEqual(whereClause({ q: { text: "50%_x", fields: ["name"] } }).params[0], "50\\%\\_x%")
  })

  it("combines filters, ids and q in one WHERE, numbered end to end", () => {
    const w = whereClause({
      equals: [{ field: "accountId", value: "acc-1" }],
      ids: ["a"],
      q: { text: "ad", fields: ["name"] },
    })
    assert.equal(w.sql, "AND body ->> $1::text = $2::text AND id = ANY($3::text[]) AND (body ->> $5::text ILIKE $4)")
    assert.deepEqual(w.params, ["accountId", "acc-1", ["a"], "ad%", "name"])
  })

  it("compares a meta column as a column, not as a jsonb key", () => {
    assert.deepEqual(whereClause({ equals: [{ field: "deleted", value: "true" }] }), {
      sql: "AND deleted = $1",
      params: [true],
    })
  })
})
