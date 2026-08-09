// Measuring, separated from judging.
//
// This file exists because `sizecaps.mjs` went over its own cap. That is the split the rule
// asks for, performed on the rule's own enforcer: what counts characters lives here, what
// compares them to a cap and prints a verdict lives there.

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, sep } from "node:path"

const SOURCE = /\.(ts|tsx|mjs|js|jsx)$/
const SKIP_DIR = new Set(["node_modules", ".next", ".git", "test-results", "screenshots", "data", "dist", "build"])

/**
 * Unit tests do not count against a cube's size.
 *
 * Counting them would mean every test written makes the gate redder — a rule that punishes the
 * behaviour the rest of this work exists to encourage. The cap is about how much CODE a cube
 * carries; its tests are measured by whether they exist and pass, which is a different gate.
 */
export const IS_TEST = /\.(test|spec)\.(ts|tsx|mjs|js|jsx)$/

export const posix = (p) => p.split(sep).join("/")

export const walk = (dir, { includeTests = false } = {}) => {
  const found = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || SKIP_DIR.has(e.name)) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) found.push(...walk(full, { includeTests }))
    else if (SOURCE.test(e.name) && (includeTests || !IS_TEST.test(e.name))) found.push(full)
  }
  return found
}

/**
 * Strip comments so the cap can measure code.
 *
 * A lexer, not a regex: a regex over `//` eats the `//` inside a URL string and the `/*` inside
 * a regular-expression literal, and the resulting number is quietly wrong. A gate whose number
 * is quietly wrong is worse than no gate, because people trust it.
 */
export const stripComments = (source) => {
  let out = ""
  let i = 0
  const n = source.length
  let quote = null

  while (i < n) {
    const c = source[i]
    const next = source[i + 1]

    if (quote) {
      out += c
      if (c === "\\") {
        out += source[i + 1] ?? ""
        i += 2
        continue
      }
      if (c === quote) quote = null
      i++
      continue
    }

    if (c === '"' || c === "'" || c === "`") {
      quote = c
      out += c
      i++
      continue
    }

    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i++
      continue
    }

    if (c === "/" && next === "*") {
      i += 2
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++
      i += 2
      continue
    }

    out += c
    i++
  }

  // Blank lines left behind by removed comments are not code either.
  return out
    .split("\n")
    .filter((l) => l.trim() !== "")
    .join("\n")
}

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
