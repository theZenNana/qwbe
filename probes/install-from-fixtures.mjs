// The fixtures the install-from probe points at: directories planted in temp space, one valid
// and each of the others built to trip exactly one refusal.
//
// Split out of `install-from.mjs` at birth, on the pattern install.mjs / install-store.mjs
// already sets: this module asserts nothing, it only builds the bench. The claims live next
// door. The good source is a renamed copy of example-plugin's bookmarks cube - only bookmarks;
// the plugin's second cube `tags` would mount a duplicate (see lifecycle-bench.mjs).

import { execSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pluginsDir } from "./lifecycle-bench.mjs"

export const plantSources = () => {
  const sources = mkdtempSync(join(tmpdir(), "qwbe-installfrom-src-"))

  // The valid one: a renamed copy of the example bookmarks cube, living OUTSIDE any store -
  // that is the whole point of the feature.
  const goodDir = join(sources, "dirplugin")
  cpSync(join(pluginsDir, "example-plugin", "cubes", "booktags", "bookmarks"), join(goodDir, "cubes", "bookmarks"), {
    recursive: true,
  })
  const cubeIndex = join(goodDir, "cubes", "bookmarks", "index.ts")
  // The source is a CHILD of booktags now: it declares `parent` and its imports reach one
  // directory deeper. A standalone copy is neither, so the fixture rewrites both -- this is
  // what the same cube looks like without a parent, which is exactly what a planted
  // standalone install needs.
  writeFileSync(
    cubeIndex,
    readFileSync(cubeIndex, "utf8")
      // Placeholders first: the compound prefix and the event name contain the bare name,
      // so renaming the bare name first would rename them twice ("dirdirbookmarks").
      .replaceAll("booktags/bookmarks:", "PPP_COLON")
      .replaceAll("booktags/bookmarks.created", "PPP_EVENT")
      .replaceAll("bookmarks", "dirbookmarks")
      // The sibling's cache table is owned by the original cube; a mounted copy must own
      // another one, or the kernel refuses both for sharing a table. AFTER the bare rename,
      // so the new name is not renamed again.
      .replaceAll('"settings-cache"', '"dirbookmarks-cache"')
      .replaceAll("PPP_COLON", "dirbookmarks:")
      .replaceAll("PPP_EVENT", "dirbookmarks.created")
      .replaceAll("../../../../../src/", "../../../../src/")
      .replace(/^\s*parent: "booktags",\n/m, ""),
  )
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
  // the STAGED copy (staging precedes it in the kernel), so this one carries real bytes --
  // a copy of `notes` renamed only where its own prefix demands, because the example cube
  // is a child of `booktags` now and no longer clashes with anything when installed flat.
  const clashDir = join(sources, "clashplugin")
  cpSync(join(pluginsDir, "..", "src", "cubes", "notes"), join(clashDir, "cubes", "notes"), { recursive: true })
  writeFileSync(
    join(clashDir, "qwbe-package.json"),
    JSON.stringify({ name: "clashplugin", kind: "plugin", cubes: ["notes"] }),
  )

  // Same name as the good one, different content - after the good one is staged, must refuse.
  // Carries the cube directory its manifest declares, so the ONLY thing wrong with it is the
  // name clash - a structurally invalid rival would be refused for the wrong reason.
  const rivalRoot = mkdtempSync(join(tmpdir(), "qwbe-installfrom-rival-"))
  const rivalDir = join(rivalRoot, "dirplugin")
  mkdirSync(join(rivalDir, "cubes", "othercube"), { recursive: true })
  writeFileSync(
    join(rivalDir, "qwbe-package.json"),
    JSON.stringify({ name: "dirplugin", kind: "plugin", summary: "same name, other bytes", cubes: ["othercube"] }),
  )
  writeFileSync(join(rivalDir, "cubes", "othercube", "index.ts"), "// different content under the same package name\n")

  // A symlink AS the root - points at the valid directory. statSync would follow it; the
  // kernel must refuse it by shape (review finding: the first version accepted it).
  const linkRoot = join(sources, "linkroot")
  symlinkSync(goodDir, linkRoot)

  // A path that exists but is a plain file, not a directory.
  const filePath = join(sources, "afile")
  writeFileSync(filePath, "// not a directory\n")

  // A FIFO inside an otherwise-valid tree - a special file must be refused like a symlink.
  const fifoDir = join(sources, "fifoplugin")
  mkdirSync(fifoDir, { recursive: true })
  writeFileSync(join(fifoDir, "qwbe-package.json"), JSON.stringify({ name: "fifoplugin", kind: "cube" }))
  writeFileSync(join(fifoDir, "index.ts"), "// has a fifo\n")
  execSync("mkfifo pipe", { cwd: fifoDir })

  // A plugin whose manifest promises a cube the directory does not carry.
  const ghostDir = join(sources, "ghostplugin")
  mkdirSync(ghostDir, { recursive: true })
  writeFileSync(
    join(ghostDir, "qwbe-package.json"),
    JSON.stringify({ name: "ghostplugin", kind: "plugin", cubes: ["ghostcube"] }),
  )
  writeFileSync(join(ghostDir, "index.ts"), "// no cubes/ directory at all\n")

  return {
    sources,
    goodDir,
    noManifest,
    liarDir,
    escapeDir,
    clashDir,
    rivalRoot,
    rivalDir,
    linkRoot,
    filePath,
    fifoDir,
    ghostDir,
  }
}
