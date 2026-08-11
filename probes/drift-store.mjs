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

  // The whole hierarchy goes on the shelf: the package declares `booktags` and must carry it,
  // or the refusal becomes "declares a cube it does not carry" instead of "already installed".
  cpSync(join(examplePluginAt, "cubes", "booktags"), join(store, "example-plugin", "cubes", "booktags"), {
    recursive: true,
  })
  writeFileSync(
    join(store, "example-plugin", "qwbe-package.json"),
    JSON.stringify({
      name: "example-plugin",
      kind: "plugin",
      summary: "the example, on the shelf",
      // What the plugin REALLY brings now: the hierarchy root, not a flat bookmarks. The
      // drift check compares this list against mounted names.
      cubes: ["booktags"],
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
