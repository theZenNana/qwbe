import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { cube, readPermissionOf } from "./index.ts"

describe("catalog cube", () => {
  it("derives a cube's read permission from its full name", () => {
    assert.equal(readPermissionOf("notes"), "notes:read")
    assert.equal(readPermissionOf("crm/contacts"), "crm/contacts:read")
  })

  it("declares no permissions of its own -- it borrows the target cube's", () => {
    assert.deepEqual(cube.manifest.permissions ?? [], [])
    assert.equal(cube.manifest.requiresAuth, true)
    assert.deepEqual(cube.manifest.tables, [])
  })
})
