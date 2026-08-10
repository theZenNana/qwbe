// The fixtures the install-from probe points at: directories planted in temp space, one valid
// and each of the others built to trip exactly one refusal.
//
// Split out of `install-from.mjs` at birth, on the pattern install.mjs / install-store.mjs
// already sets: this module asserts nothing, it only builds the bench. The claims live next
// door. The good source is a renamed copy of example-plugin's bookmarks cube - only bookmarks;
// the plugin's second cube `tags` would mount a duplicate (see lifecycle-bench.mjs).

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pluginsDir } from "./lifecycle-bench.mjs"

export const plantSources = () => {
  const sources = mkdtempSync(join(tmpdir(), "qwbe-installfrom-src-"))

  // The valid one: a renamed copy of the example bookmarks cube, living OUTSIDE any store -
  // that is the whole point of the feature.
  const goodDir = join(sources, "dirplugin")
  cpSync(join(pluginsDir, "example-plugin", "cubes", "bookmarks"), join(goodDir, "cubes", "bookmarks"), {
    recursive: true,
  })
  const cubeIndex = join(goodDir, "cubes", "bookmarks", "index.ts")
  writeFileSync(cubeIndex, readFileSync(cubeIndex, "utf8").replaceAll("bookmarks", "dirbookmarks"))
  mkdirSync(join(goodDir, "cubes", "dirbookmarks"), { recursive: true })
  cpSync(join(goodDir, "cubes", "bookmarks"), join(goodDir, "cubes", "dirbookmarks"), { recursive: true })
  rmSync(join(goodDir, "cubes", "bookmarks"), { recursive: true, force: true })
  writeFileSync(
    join(goodDir, "qwbe-package.json"),
    JSON.stringify({
      name: "dirplugin",
      kind: "plugin",
      summary: "planted outside any store",
      cubes: ["dirbookmarks"],
    }),
  )

  // A directory with no manifest at all.
  const noManifest = join(sources, "nomanifest")
  mkdirSync(noManifest, { recursive: true })
  writeFileSync(join(noManifest, "index.ts"), "// no manifest here\n")

  // A manifest that names something other than its directory.
  const liarDir = join(sources, "liarplugin")
  mkdirSync(liarDir, { recursive: true })
  writeFileSync(join(liarDir, "qwbe-package.json"), JSON.stringify({ name: "othername", kind: "cube" }))
  writeFileSync(join(liarDir, "index.ts"), "// liar\n")

  // A symlink inside the tree, pointing OUT of the source root.
  const escapeDir = join(sources, "escapeplugin")
  mkdirSync(escapeDir, { recursive: true })
  writeFileSync(join(escapeDir, "qwbe-package.json"), JSON.stringify({ name: "escapeplugin", kind: "cube" }))
  symlinkSync(join(pluginsDir, "example-plugin"), join(escapeDir, "sneaky"))

  // A source that would bring a cube name already on disk. The duplicate check runs against
  // the STAGED copy (staging precedes it in the kernel), so this one carries real bytes.
  const clashDir = join(sources, "clashplugin")
  cpSync(join(pluginsDir, "example-plugin", "cubes", "bookmarks"), join(clashDir, "cubes", "bookmarks"), {
    recursive: true,
  })
  writeFileSync(
    join(clashDir, "qwbe-package.json"),
    JSON.stringify({ name: "clashplugin", kind: "plugin", cubes: ["bookmarks"] }),
  )

  // Same name as the good one, different content - after the good one is staged, must refuse.
  const rivalRoot = mkdtempSync(join(tmpdir(), "qwbe-installfrom-rival-"))
  const rivalDir = join(rivalRoot, "dirplugin")
  mkdirSync(rivalDir, { recursive: true })
  writeFileSync(
    join(rivalDir, "qwbe-package.json"),
    JSON.stringify({ name: "dirplugin", kind: "plugin", summary: "same name, other bytes", cubes: ["othercube"] }),
  )
  writeFileSync(join(rivalDir, "index.ts"), "// different content under the same package name\n")

  return { sources, goodDir, noManifest, liarDir, escapeDir, clashDir, rivalRoot, rivalDir }
}
