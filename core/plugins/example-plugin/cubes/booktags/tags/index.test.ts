// The tags cube's manifest, held to the same validation as every other cube.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { validateManifest } from "qwbe-core/cube"
import { cube } from "./index.ts"

describe("tags manifest", () => {
  it("passes the kernel's own validation", () => {
    assert.doesNotThrow(() => validateManifest("tags", cube.manifest))
  })

  it("names its directory and owns exactly its table", () => {
    assert.equal(cube.manifest.name, "tags")
    assert.deepEqual(cube.manifest.tables, ["tags"])
  })
})
