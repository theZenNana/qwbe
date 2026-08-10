import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { installerFor } from "./install.ts"

describe("cubeOnDisk - discovery names outside the package slug grammar", () => {
  it("reports absent instead of taking the settings catalogue down", () => {
    assert.equal(installerFor().cubeOnDisk("bookmarks", "example_plugin"), false)
  })
})
