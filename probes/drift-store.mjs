// The shelf the drift probe works against: temporary, planted, gone at the end.
//
// Two packages. One is a copy of the in-repo example-plugin - installing from the shelf must
// be able to mount a real cube, and the only real cube this repo still ships is the example.
// The other is a rival that also claims `bookmarks`: two store packages picking the same cube
// name is not exotic, it happened on the real store with `contacts`, and the probe exists to
// prove the overlap is refused rather than misread as drift.

import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const plantRivalStore = (examplePluginAt) => {
  const store = mkdtempSync(join(tmpdir(), "qwbe-drift-store-"))

  // Only the first cube goes on the shelf: the plugin's second cube (`tags`) would collide with
  // the mounted in-repo one if the copy were ever installed.
  cpSync(join(examplePluginAt, "cubes", "bookmarks"), join(store, "example-plugin", "cubes", "bookmarks"), {
    recursive: true,
  })
  writeFileSync(
    join(store, "example-plugin", "qwbe-package.json"),
    JSON.stringify({
      name: "example-plugin",
      kind: "plugin",
      summary: "the example, on the shelf",
      cubes: ["bookmarks"],
    }),
  )

  const rivalDir = join(store, "rival-plugin", "cubes", "bookmarks")
  mkdirSync(rivalDir, { recursive: true })
  writeFileSync(
    join(store, "rival-plugin", "qwbe-package.json"),
    JSON.stringify({ name: "rival-plugin", kind: "plugin", summary: "claims bookmarks too", cubes: ["bookmarks"] }),
  )
  writeFileSync(join(rivalDir, "index.ts"), "// planted by probes/drift.mjs - never mounted\n")

  return store
}
