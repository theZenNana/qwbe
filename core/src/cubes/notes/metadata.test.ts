// The ticket's proof, on a REAL system cube (QWB-54, ticket 10): the metadata the kernel
// publishes carries the permission each route requires, read from the cube's own one
// declaration -- not a copy a test holds. The rename proof lives in metadata.test.ts (a
// fixture renames); this file proves the real system cube publishes through the same path.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { deriveCubeMetadata } from "../../metadata/metadata.ts"
import { cube } from "./index.ts"

// `create` refuses to run without the entity-permissions capability the manifest declares,
// but only the HANDLERS ever call into it -- the store, the bus and the capability are needed
// here only to build the parts, never invoked. Reading the contract must not need a store.
const tools = {
  store: {},
  bus: { publish: () => undefined as never },
  entityPermissions: {},
} as never

const md = deriveCubeMetadata(
  { name: cube.manifest.name, manifest: cube.manifest, parts: { group: cube.create(tools).group } } as never,
  [],
  [],
)

describe("notes metadata -- the permission of each route, published (QWB-54, ticket 10)", () => {
  it("publishes each route's permission from the declaration the handlers check through", () => {
    assert.ok(md)
    assert.deepEqual(md.routes, {
      list: { auth: true, permission: "notes:read" },
      get: { auth: true, permission: "notes:read" },
      create: { auth: true, permission: "notes:write" },
    })
  })

  it("derives the auth requirement from the Authorization middleware the group carries", () => {
    assert.ok(md)
    for (const route of Object.values(md.routes)) assert.equal(route.auth, true)
  })
})
