import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { cube } from "./index.ts"

describe("agentlab cube contract", () => {
  it("publishes an authenticated agent-only surface", () => {
    assert.equal(cube.manifest.name, "agentlab")
    assert.equal(cube.manifest.agent, true)
    assert.equal(cube.manifest.screen, false)
    assert.equal(cube.manifest.requiresAuth, true)
  })
})
