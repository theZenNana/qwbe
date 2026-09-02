// The size probes' measuring half. What it judges (caps, baselines, verdicts) lives in
// sizecaps.mjs / testgate.mjs; what counts characters imports from the kernel itself, the
// same module `qwbe check` uses -- one walk, one count, everywhere.
//
// Kept here, probe-specific: `unitDirs` (what one unit is: cube/space/kernel/pg/metadata/host)
// and `measure` (raw vs code, the numbers the baselines carry).

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { IS_TEST, posix, stripComments, walk } from "../core/src/package-size.ts"

export { IS_TEST, posix, walk }

export const measure = (file) => {
  const source = readFileSync(file, "utf8")
  return { raw: source.length, code: stripComments(source).length }
}

const children = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith("."))
  } catch {
    return []
  }
}

/**
 * What counts as one unit: a cube directory, a space, or the kernel.
 *
 * Cubes are found the way the kernel finds them — by reading the directories, not from a list.
 * A list would go stale the first time someone adds a cube, and a size gate that silently skips
 * the newest cube is exactly the kind of gate people walk through.
 */
export const unitDirs = (root) => {
  const units = []
  // `id` is the directory, not the pretty name. The pretty name is not unique: `crm-pack` lives
  // both in core/plugins (mounted) and in core/store (installable), so two different directories
  // were called `cube crm-pack/contacts` and any baseline keyed by name excused both when only
  // one had been fixed. Caught by the gate's own first run.
  const add = (name, dir) => {
    try {
      if (statSync(dir).isDirectory()) units.push({ id: posix(dir.slice(root.length + 1)), name, dir })
    } catch {
      /* not present in this checkout */
    }
  }

  for (const c of children(join(root, "core/src/cubes"))) add(`cube ${c.name}`, join(root, "core/src/cubes", c.name))
  for (const s of children(join(root, "core/src/spaces"))) add(`space ${s.name}`, join(root, "core/src/spaces", s.name))
  add("kernel", join(root, "core/src/kernel"))
  // The pg store is its own measured unit (one Postgres, one schema per cube): a new subsystem
  // becomes its own unit the day the directory is born -- measured from the first commit,
  // never a blind spot.
  add("pg store", join(root, "core/src/pg"))
  // The metadata module likewise (per-cube field metadata): its own unit from the first
  // commit, never a blind spot.
  add("metadata", join(root, "core/src/metadata"))
  // The machine-facing modules the kernel lends to a cube (`host/workstation.ts` and what it
  // uses). Added the day the directory was born, not after: the per-file cap already covered
  // those files, but the per-unit one did not, so moving code out of a cube and into here would
  // have been a way to shed 20000 characters of unit weight without anyone measuring it.
  add("host", join(root, "core/src/host"))

  for (const holder of ["core/plugins", "core/store"]) {
    for (const pack of children(join(root, holder))) {
      const cubesDir = join(root, holder, pack.name, "cubes")
      for (const c of children(cubesDir)) add(`cube ${pack.name}/${c.name}`, join(cubesDir, c.name))
    }
  }
  return units
}
