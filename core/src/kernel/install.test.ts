import assert from "node:assert/strict"
import { Effect } from "effect"
import { describe, it } from "vitest"
import { isPackageCubeIdentity } from "../package-source.ts"
import { installerFor } from "./install.ts"

describe("plugin package cube identities", () => {
  it("accepts one parent/child identity and refuses unsafe paths", () => {
    assert.equal(isPackageCubeIdentity("crm/contacts"), true)
    for (const name of ["crm/", "/contacts", "crm//contacts", "crm/contacts/deep", "../contacts"]) {
      assert.equal(isPackageCubeIdentity(name), false, name)
    }
  })
})

describe("cubeOnDisk - discovery names outside the package slug grammar", () => {
  it("reports absent instead of taking the settings catalogue down", async () => {
    assert.equal(await Effect.runPromise(installerFor(async () => []).cubeOnDisk("bookmarks", "example_plugin")), false)
  })
})
