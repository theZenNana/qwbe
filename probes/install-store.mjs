// The material the install probe attacks: a store of our own, and a way to measure the tree.
//
// The probe plants its own store in a temp directory (`QWBE_STORE_DIR`) instead of using the
// real one, so it proves the MECHANISM rather than whatever happens to be shipped today. Two of
// the packages here are deliberately malformed — a store is exactly where a bad package arrives
// from, and a probe that only ever sees good input tests the happy path of a security boundary.
//
// Kept apart from the probe next door because none of this asserts anything. It is the fixture;
// the claims live in `install.mjs`.

import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { root } from "./lib.mjs"

/**
 * Build the store on disk and return its path.
 *
 * A function rather than a top-level side effect: importing a module should not create
 * directories, and the caller decides when the store exists relative to starting the server.
 */
export const plantStore = () => {
  const store = mkdtempSync(join(tmpdir(), "qwbe-store-"))

  const plantCube = (name, body) => {
    const dir = join(store, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "qwbe-package.json"),
      JSON.stringify(body ?? { name, kind: "cube", summary: `${name} probe package` }),
    )
    writeFileSync(join(dir, "index.ts"), `// planted by probes/install.mjs — ${name}\n`)
    return dir
  }

  plantCube("probecube")
  // Manifest names something other than its directory: installs as one thing, appears as another.
  plantCube("liarcube", { name: "somethingelse", kind: "cube", summary: "manifest names another cube" })
  // A directory with no manifest at all is scratch, not a package.
  mkdirSync(join(store, "notapackage"), { recursive: true })
  writeFileSync(join(store, "notapackage", "index.ts"), "// no manifest\n")

  // A plugin, to prove the second destination is guarded the same way.
  const pluginDir = join(store, "probeplugin", "cubes", "probeplugincube")
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(
    join(store, "probeplugin", "qwbe-package.json"),
    JSON.stringify({ name: "probeplugin", kind: "plugin", summary: "probe plugin", cubes: ["probeplugincube"] }),
  )
  writeFileSync(join(pluginDir, "index.ts"), "// planted by probes/install.mjs\n")

  // A rival plugin bringing a cube name the one above also brings. Two packages in a store having
  // picked the same cube name is not exotic — it happened on the real store with `contacts`.
  const rivalDir = join(store, "rivalplugin", "cubes", "probeplugincube")
  mkdirSync(rivalDir, { recursive: true })
  writeFileSync(
    join(store, "rivalplugin", "qwbe-package.json"),
    JSON.stringify({ name: "rivalplugin", kind: "plugin", summary: "clashes on purpose", cubes: ["probeplugincube"] }),
  )
  writeFileSync(join(rivalDir, "index.ts"), "// planted by probes/install.mjs\n")

  return store
}

/** SHA-256 over every file in a directory tree, so "nothing existing was touched" is measured. */
export const fingerprint = (dir) => {
  const out = new Map()
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.set(relative(root, p), createHash("sha256").update(readFileSync(p)).digest("hex"))
    }
  }
  walk(dir)
  return out
}
