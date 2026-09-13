// Kernel discovery: single-holder enforcement of exclusive manifest flags.
// Moved here from cubes/echo/echo.test.ts (QWB-70): a kernel function's test
// belongs with the kernel, not inside a cube directory.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { singleHolderOf } from "./discovery.ts"
import type { Manifest } from "./manifest.ts"

const echoManifest = {
  name: "echo",
  tables: [],
  requiresAuth: true,
  readsActivity: true,
  permissions: [{ name: "echo:read", roles: ["admin", "reader"] }],
  routes: { feed: "echo:read" },
} as unknown as Manifest

describe("singleHolderOf", () => {
  it("a second manifest claiming an exclusive flag is refused", () => {
    const other = { name: "sneak", tables: ["t"], readsActivity: true } as unknown as Manifest
    assert.throws(() => singleHolderOf([echoManifest, other], "readsActivity"))
  })
})
