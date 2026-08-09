// The bench the lifecycle probe works on: where the packages live, how the tree is measured,
// and how whatever was already installed is moved out of the way and put back.
//
// None of this checks anything. It exists so the probe next door can start from a known bench
// on a machine that is not clean — which is the only kind of machine this runs on.

import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join, relative } from "node:path"
import { client, freePort, root, scratchDataDir, startServer } from "./lib.mjs"

export const cubesDir = join(root, "core", "src", "cubes")
export const pluginsDir = join(root, "core", "plugins")
export const storeDir = join(root, "core", "store")

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

export const cubesOf = (pkg) =>
  JSON.parse(readFileSync(join(storeDir, pkg, "qwbe-package.json"), "utf8")).cubes ?? [pkg]

// ── Clearing the bench ────────────────────────────────────────────────────────────────────────
// Anything already installed would make the first install refuse for the right reason at the
// wrong time. It is moved, not deleted: some of it is work that was never committed.

export const parking = scratchDataDir("qwbe-lifecycle-parked")
const parked = []

// Copy-then-delete rather than rename: the parking lot is under /tmp, which on this machine is
// a different filesystem, and `rename` across devices fails with EXDEV. Copying is slower and
// cannot fail halfway into a half-moved directory.
export const moveAside = (from) => {
  if (!existsSync(from)) return
  const to = join(parking, `${parked.length}-${relative(root, from).replaceAll("/", "_")}`)
  cpSync(from, to, { recursive: true })
  rmSync(from, { recursive: true, force: true })
  parked.push({ from, to })
}

export const putBack = () => {
  for (const { from, to } of parked.reverse()) {
    rmSync(from, { recursive: true, force: true })
    mkdirSync(join(from, ".."), { recursive: true })
    cpSync(to, from, { recursive: true })
  }
  parked.length = 0
}

/** One server on a port the OS says is free, reading the databases directory it is handed. */
export const boot = async (dataDir) => {
  const port = await freePort()
  const server = await startServer(port, { QWBE_DATA_DIR: dataDir })
  return { server, api: client(port), port }
}

/** Everything the store offers, moved off the bench. */
export const clearTheBench = () => {
  for (const pkg of readdirSync(storeDir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const manifest = join(storeDir, pkg.name, "qwbe-package.json")
    if (!existsSync(manifest)) continue
    const { kind } = JSON.parse(readFileSync(manifest, "utf8"))
    moveAside(kind === "plugin" ? join(pluginsDir, pkg.name) : join(cubesDir, pkg.name))
    for (const cube of cubesOf(pkg.name)) moveAside(join(cubesDir, cube))
  }
}
