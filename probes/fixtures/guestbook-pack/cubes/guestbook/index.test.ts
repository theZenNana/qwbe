// The fixture cube's unit test (the testgate requires one per shipped cube). The cube is
// deliberately minimal -- it exists to hold rows for the customfields probe -- so the test
// pins the manifest contract it must keep for that role: plain role permissions, no entity
// permissions, exactly one table.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { cube } from "./index.ts"

describe("guestbook fixture cube", () => {
  it("keeps the manifest the customfields walk depends on", () => {
    assert.equal(cube.manifest.name, "guestbook")
    assert.deepEqual(cube.manifest.tables, ["guestbook"])
    assert.deepEqual(
      cube.manifest.permissions.map((p) => p.name),
      ["guestbook:read", "guestbook:write"],
    )
    assert.equal(cube.manifest.usesEntityPermissions, undefined)
  })
})
