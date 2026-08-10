// The bench the lifecycle probe works on: where packages live, how the tree is measured, and
// how a second, installable copy of the example plugin is planted without touching the repo.
//
// None of this checks anything. It exists so the probe next door can start from a known bench.
//
// Until 10 Aug 2026 the bench parked whatever the real store offered (`clearTheBench`,
// `putBack`) and installed the real crm-pack. The packs left in QWB-13; what remains true is
// that a plugin must install, mount at restart, work, and uninstall cleanly. The one plugin the
// repo still ships is example-plugin - and it is already mounted from `core/plugins/`, so the
// probe plants a COPY of it under a different package name in a temp store. The copy is real
// code that can really mount; the name is new, so nothing collides.

import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { client, freePort, root, scratchDataDir, startServer } from "./lib.mjs"

export const cubesDir = join(root, "core", "src", "cubes")
export const pluginsDir = join(root, "core", "plugins")

/** The planted package's name, and the cube name inside the copy. */
export const PKG = "lifecycle-plugin"
export const PKG_CUBE = "lifebookmarks"

/** Every file under the source tree the installer is allowed to write into, by content. */
export const fingerprint = () => {
  const seen = new Map()
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else seen.set(relative(root, full), createHash("sha256").update(readFileSync(full)).digest("hex"))
    }
  }
  walk(cubesDir)
  walk(pluginsDir)
  return seen
}

/**
 * A temp store holding a renamed copy of example-plugin's FIRST cube. Only `bookmarks` is
 * copied - the plugin gained a second cube (`tags`) for QWB-14, and copying both would mount a
 * duplicate `tags` and the kernel would refuse to boot. The cube directory and every
 * "bookmarks" mention inside it become `lifebookmarks`, so installing the copy cannot collide
 * with the mounted original.
 */
export const plantLifecycleStore = () => {
  const store = mkdtempSync(join(tmpdir(), "qwbe-lifecycle-store-"))
  const src = join(pluginsDir, "example-plugin", "cubes", "bookmarks")
  const cubeDir = join(store, PKG, "cubes", "bookmarks")
  cpSync(src, cubeDir, { recursive: true })
  const indexAt = join(cubeDir, "index.ts")
  const source = readFileSync(indexAt, "utf8")
  const renamed = source.replaceAll("bookmarks", PKG_CUBE)
  if (renamed === source) throw new Error('example-plugin no longer names its cube "bookmarks" - rewrite missed')
  writeFileSync(indexAt, renamed)
  renameSync(cubeDir, join(store, PKG, "cubes", PKG_CUBE))
  writeFileSync(
    join(store, PKG, "qwbe-package.json"),
    JSON.stringify({
      name: PKG,
      kind: "plugin",
      summary: "renamed copy of the example bookmarks cube",
      cubes: [PKG_CUBE],
    }),
  )
  return store
}

/** One server on a port the OS says is free, reading the databases directory it is handed. */
export const boot = async (dataDir, store) => {
  const port = await freePort()
  const server = await startServer(port, { QWBE_DATA_DIR: dataDir, QWBE_STORE_DIR: store })
  return { server, api: client(port), port }
}

export const scratch = scratchDataDir
