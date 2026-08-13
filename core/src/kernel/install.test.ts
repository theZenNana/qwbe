import assert from "node:assert/strict"
import { describe, it } from "node:test"
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
  it("reports absent instead of taking the settings catalogue down", () => {
    assert.equal(installerFor().cubeOnDisk("bookmarks", "example_plugin"), false)
  })
})
