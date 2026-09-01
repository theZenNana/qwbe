import assert from "node:assert/strict"
import { join } from "node:path"
import { test } from "node:test"
import { includePackageSourcePath, isLocalSourceDirectory } from "./package-source.ts"

// QWB-54 ticket 22: an `install-from` of a live checkout found `.pi/` and `.claude/` on disk and
// would have staged the agent tool state into the store. Hidden entries are authoring tool state
// by definition - the leading-dot rule, not a name list, is what keeps the next tool out too.
test("hidden authoring tool state never ships in a package", () => {
  for (const junk of [".git", ".venv", ".pi", ".claude", ".githooks", ".gitignore"]) {
    assert.equal(isLocalSourceDirectory(junk), true, junk)
    assert.equal(includePackageSourcePath("/repo", join("/repo", junk, "any")), false, junk)
  }
  assert.equal(includePackageSourcePath("/repo", join("/repo", "cubes", "contacts", "index.ts")), true)
  assert.equal(includePackageSourcePath("/repo", join("/repo", "qwbe-package.json")), true)
})
