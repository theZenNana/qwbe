import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Schema } from "effect"
import { EntityVisibilitySchema, VisibilityListParams, VisibilityMutationSchema } from "./permissions-contracts.ts"

describe("permissions visibility runtime contract", () => {
  it("decodes a typed provenance row", () => {
    const row = Schema.decodeUnknownSync(EntityVisibilitySchema)({
      cube: "crm/contacts",
      entityType: "Contact",
      entityId: "contact-42",
      ownerId: "ana",
      createdBy: "ioana",
      createdAt: "2026-08-15T00:00:00.000Z",
      access: { source: "group-grant", name: "Sales", actions: ["read"] },
      hidden: false,
      sharedWithCount: 1,
    })
    assert.equal(row.access.source, "group-grant")
    assert.equal(row.createdBy, "ioana")
  })

  it("defaults the server-side list and decodes an explicit filter", () => {
    assert.deepEqual(Schema.decodeUnknownSync(VisibilityListParams)({}), {
      view: "all",
      sortBy: "createdAt",
      descending: false,
      offset: 0,
      limit: 10,
    })
    assert.equal(
      Schema.decodeUnknownSync(VisibilityListParams)({ view: "hidden-by-me", offset: "20", limit: "5" }).view,
      "hidden-by-me",
    )
    assert.throws(() => Schema.decodeUnknownSync(VisibilityListParams)({ view: "others-hidden" }))
  })

  it("requires an explicit boolean for Hide and Unhide", () => {
    assert.deepEqual(Schema.decodeUnknownSync(VisibilityMutationSchema)({ hidden: true }), { hidden: true })
    assert.throws(() => Schema.decodeUnknownSync(VisibilityMutationSchema)({ hidden: "true" }))
  })
})
