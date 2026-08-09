#!/usr/bin/env node
// Every package on the shelf can actually be loaded.
//
//   node probes/store.mjs
//
// `core/store/` is what a user installs from. A package there is a promise: press install, get a
// working cube. On 3 Aug 2026 `core/store/tasks/` had been breaking that promise since the shelf
// existed — its imports reached for `../../kernel/`, which from `core/store/tasks/` resolves to
// `core/kernel/`, a directory that does not exist. Installing it produced a server that would
// not start at all.
//
// It survived because of HOW the store was tested. `probes/install.mjs` is thorough about the
// install ROUTE — permissions, path traversal, collisions, refusals — but every package it
// installs is one it fabricates itself in a temp directory. Nothing ever loaded a real one. A
// package that no probe mounts is not "green"; it is unmounted, which looks the same from here.
//
// So this probe does the cheapest thing that would have caught it: import each package's entry
// point and see whether Node can resolve it. No server, no HTTP — a broken import cannot be
// argued with, and the failure it prevents is exactly "the server refuses to start".
//
// Depth is the trap worth naming: a `kind: "cube"` package sits at `core/store/<name>/`, one
// level higher than a plugin's cube at `core/store/<pack>/cubes/<name>/`. Same-looking imports,
// different number of `../`. That is why this walks the shelf instead of listing names.

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { makeScore } from "./lib.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const store = join(root, "core", "store")
const score = makeScore()

/** Entry points on the shelf: `<pack>/cubes/<cube>/index.ts` for plugins, `<name>/index.ts` for a lone cube. */
const entryPoints = () => {
  const found = []
  for (const name of readdirSync(store, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const dir = join(store, name.name)
    const manifest = join(dir, "qwbe-package.json")
    const kind = existsSync(manifest) ? (JSON.parse(readFileSync(manifest, "utf8")).kind ?? "cube") : "cube"
    if (kind === "plugin") {
      const cubes = join(dir, "cubes")
      if (!existsSync(cubes)) continue
      for (const cube of readdirSync(cubes, { withFileTypes: true }).filter((d) => d.isDirectory())) {
        found.push({ pkg: name.name, kind, file: join(cubes, cube.name, "index.ts") })
      }
    } else {
      found.push({ pkg: name.name, kind, file: join(dir, "index.ts") })
    }
  }
  return found
}

const points = entryPoints()
console.log(`\nthe store, loaded for real — ${points.length} entry points\n`)

score.check(
  "the shelf is not empty — a probe over nothing would pass forever",
  points.length > 0,
  `${points.length} found`,
)

for (const { pkg, kind, file } of points) {
  const rel = file.slice(root.length + 1)
  let failure = null
  try {
    await import(file)
  } catch (err) {
    failure = err.message.split("\n")[0]
  }
  score.check(`${pkg} (${kind}) loads — ${rel}`, failure === null, failure ?? "resolved")
}

process.exit(score.report("Store probe — every package on the shelf loads"))
