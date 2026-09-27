import assert from "node:assert/strict"
import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { isPackageCubeIdentity } from "../package-source.ts"
import { testConfig } from "../test-config.ts"
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
  it.effect("reports absent instead of taking the settings catalogue down", () =>
    Effect.gen(function* () {
      assert.equal(yield* installerFor(async () => [], testConfig()).cubeOnDisk("bookmarks", "example_plugin"), false)
    }),
  )
})
