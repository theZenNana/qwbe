import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join, sep } from "node:path"
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

// Review 14b finding 6: the strict shelf rule landed in store-drift and install-from, but the
// install scanner kept hashing shelves with the lax source rule -- a shelf poisoned with
// node_modules/ showed "identical" in the UI while installFrom refused it. The rule now lives
// in ONE function, shelfFingerprint. Outside this module, a direct packageSourceFingerprint
// call is legal only for a SOURCE checkout: one argument, no exclusions, no flag. A reader
// that re-derives a shelf hash by hand -- lax or strict -- changes the pinned set below and
// fails here, before a third reader ships again. Source-side additions are legitimate: add
// them to the list consciously.
test("every shelf fingerprint routes through shelfFingerprint; no reader re-derives the rule", () => {
  const callSites: Array<{ file: string; call: string }> = []
  for (const path of readdirSync(import.meta.dirname, { recursive: true, encoding: "utf8" })) {
    if (!path.endsWith(".ts") || path.endsWith(".test.ts")) continue
    const file = path.split(sep).join("/")
    if (file === "package-source.ts") continue // the rule's own module
    const text = readFileSync(join(import.meta.dirname, path), "utf8")
    for (const match of text.matchAll(/packageSourceFingerprint\([^()]*\)/g)) {
      callSites.push({ file, call: match[0].replace(/\s+/g, " ") })
    }
  }
  callSites.sort((a, b) => `${a.file} ${a.call}`.localeCompare(`${b.file} ${b.call}`))
  assert.deepEqual(callSites, [
    { file: "kernel/install-from.ts", call: "packageSourceFingerprint(source)" },
    { file: "kernel/install-scan.ts", call: "packageSourceFingerprint(dir)" },
    { file: "store-drift.ts", call: "packageSourceFingerprint(provenance.sourcePath)" },
  ])
})
