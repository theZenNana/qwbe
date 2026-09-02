// The declarations dump -- one input of the generic probes (QWB-54, ticket 08).
//
// Spawned by `qwbe check` (check-package.ts) against the package being judged. Imports each
// cube's entry module the way discovery does and reports what the cube DECLARED about itself:
// `searchable`, `relations`, `dataMigration`.
//
// Why the raw declarations and not the published metadata: the derivation deliberately hides
// broken declarations from clients. A relation whose target is not mounted publishes as
// `relation: null`; a `searchable` name that cannot be an SQL identifier is dropped from the
// list contract. A gate cannot judge what a derivation smoothed away -- the probe must see
// the claim as written, then hold it against the catalog the kernel serves.
//
// Input (environment, set by the caller):
//   QWBE_PACK_DIR         the package directory (qwbe-package.json lives here)
//   QWBE_PACK_CUBES       JSON array of cube names, from the package manifest
//   QWBE_DECLARATIONS_OUT file the JSON result is written to
//
// The result is a file, not stdout: cube modules may print at import time, and one JSON
// document must survive. Exit 0 even when a module fails to import -- the failure is a
// per-cube entry in `errors`, and the caller turns it into a finding with the cube's name.

import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const dir = process.env.QWBE_PACK_DIR ?? process.cwd()
let cubes = []
try {
  const parsed = JSON.parse(process.env.QWBE_PACK_CUBES ?? "[]")
  if (Array.isArray(parsed)) cubes = parsed.filter((c) => typeof c === "string")
} catch {
  // Caller bug -- the probes see an empty package rather than a half-read one.
}

const out = { cubes: {}, errors: {} }
for (const name of cubes) {
  const base = join(dir, "cubes", ...name.split("/"))
  const entry = ["index.ts", "index.js"].map((f) => join(base, f)).find((f) => existsSync(f))
  if (!entry) {
    out.errors[name] = `no entry file (index.ts or index.js) under cubes/${name}`
    continue
  }
  try {
    const mod = await import(pathToFileURL(entry).href)
    // A cube is whatever the module exports that carries a manifest -- `cube` on packs built
    // with the qwbe-core/cube helper, any name on a hand-rolled one. Same rule the package
    // contract's hierarchy check uses.
    const definition = Object.values(mod).find((v) => v !== null && typeof v === "object" && "manifest" in v)
    const m = definition?.manifest ?? {}
    out.cubes[name] = {
      searchable: m.searchable,
      relations: m.relations,
      dataMigration: m.dataMigration,
    }
  } catch (e) {
    out.errors[name] = String(e?.message ?? e)
  }
}

const outPath = process.env.QWBE_DECLARATIONS_OUT
if (!outPath) {
  console.error("check-manifests: QWBE_DECLARATIONS_OUT is not set")
  process.exit(2)
}
writeFileSync(outPath, JSON.stringify(out, null, 2))
