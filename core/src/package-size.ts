// Measuring a PACKAGE against the kernel's size caps, for `qwbe check`.
//
// The caps live in the kernel's qwbe.config.json and the kernel measures ITSELF with
// `probes/sizecaps.mjs`. A pack is measured by the same numbers, never by numbers of its own:
// that is the whole point of the check command -- a pack cannot write its own rules. This
// module is therefore deliberately the same walk and the same character count as
// `probes/size-lib.mjs` (the pack-facing half of it: walk, measure, judge against caps). The
// two must not drift; opening `qwbe-core/size` as a public subpath is where the copies become
// one file.
//
// One unit is one cube directory: a pack's `cubes/` children, walked recursively. The same
// exemptions as the kernel's own gate apply: tests do not count, `node_modules` and friends are
// skipped at any depth, and a `frontend/` nested INSIDE a cube counts like any other source --
// only the pack's TOP-level `frontend/` is outside the contract, and this walk never
// starts there.

import { type Dirent, readdirSync, readFileSync } from "node:fs"
import { join, sep } from "node:path"

import type { PackageFinding } from "./package-contract-scan.ts"

const SOURCE = /\.(ts|tsx|mjs|js|jsx)$/
const SKIP_DIR = new Set([
  "node_modules",
  ".next",
  ".git",
  "test-results",
  "screenshots",
  "data",
  "dist",
  "build",
  "store",
  "probes",
])

/**
 * Unit tests do not count against a cube's size -- the same rule the kernel holds itself to.
 * A test's measure is whether it exists and passes, which is a different gate.
 */
const IS_TEST = /\.(test|spec)\.(ts|tsx|mjs|js|jsx)$/

const posix = (p: string): string => p.split(sep).join("/")

const walk = (dir: string, { includeTests = false, top = true } = {}): string[] => {
  const found: string[] = []
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || SKIP_DIR.has(e.name)) continue
    // `frontend` at the TOP of the walk is the pack's UI, outside the cube contract.
    // Nested `frontend/` counts like any other source -- a one-directory bypass across the
    // whole tree would be exactly the hole the kernel's own gate once had.
    if (top && e.name === "frontend") continue
    const full = join(dir, e.name)
    if (e.isDirectory()) found.push(...walk(full, { includeTests, top: false }))
    else if (SOURCE.test(e.name) && (includeTests || !IS_TEST.test(e.name))) found.push(full)
  }
  return found
}

/**
 * Strip comments so the cap can measure code.
 *
 * A lexer, not a regex, for the reason `probes/size-lib.mjs` gives: a regex over `//` eats the
 * `//` inside a URL string, and the resulting number is quietly wrong. A gate whose number is
 * quietly wrong is worse than no gate, because people trust it.
 */
export const stripComments = (source: string): string => {
  let out = ""
  let i = 0
  const n = source.length
  let quote: string | null = null

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

const measure = (file: string): { raw: number; code: number } => {
  const source = readFileSync(file, "utf8")
  return { raw: source.length, code: stripComments(source).length }
}

/** The caps a pack is judged against, read from the installed kernel's qwbe.config.json. */
export type SizeCaps = {
  readonly countMode: "code" | "raw"
  readonly maxCharsPerFile: number
  readonly maxFilesPerUnit: number
  readonly maxCharsPerUnit: number
}

export type RawConfig = {
  readonly countMode?: unknown
  readonly caps?: {
    readonly maxCharsPerFile?: unknown
    readonly maxFilesPerUnit?: unknown
    readonly maxCharsPerUnit?: unknown
  }
}

/** Parse and validate the caps section. A wrong number here is a kernel problem, not a finding. */
export const capsFromConfig = (config: RawConfig): SizeCaps => {
  const caps = config.caps
  const num = (v: unknown, name: string): number => {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new TypeError(`qwbe.config.json: caps.${name} must be a positive number, got ${JSON.stringify(v)}`)
    }
    return v
  }
  return {
    countMode: config.countMode === "raw" ? "raw" : "code",
    maxCharsPerFile: num(caps?.maxCharsPerFile, "maxCharsPerFile"),
    maxFilesPerUnit: num(caps?.maxFilesPerUnit, "maxFilesPerUnit"),
    maxCharsPerUnit: num(caps?.maxCharsPerUnit, "maxCharsPerUnit"),
  }
}

const children = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * Judge a package's cubes against the caps. Units are the direct children of `<root>/cubes/`,
 * exactly the units the kernel's own gate measures for an installed pack. No baseline: the
 * baseline is the KERNEL's recorded debt, keyed by kernel paths -- a pack gets the caps and
 * nothing else, so anything over cap is a finding.
 */
export const sizeCapsFindings = (root: string, caps: SizeCaps): PackageFinding[] => {
  const findings: PackageFinding[] = []
  for (const name of children(join(root, "cubes"))) {
    const unitDir = join(root, "cubes", name)
    const files = walk(unitDir, { top: false })
    let chars = 0
    for (const file of files) {
      const m = measure(file)
      chars += m[caps.countMode]
      const rel = posix(`${file.slice(root.length + 1)}`)
      if (m[caps.countMode] > caps.maxCharsPerFile) {
        findings.push({
          rule: "size-file",
          file: rel,
          message:
            `${m[caps.countMode]} ${caps.countMode} chars, cap is ${caps.maxCharsPerFile} ` +
            `(caps come from the installed kernel's qwbe.config.json)`,
        })
      }
    }
    if (files.length > caps.maxFilesPerUnit || chars > caps.maxCharsPerUnit) {
      findings.push({
        rule: "size-unit",
        file: `cubes/${name}`,
        message:
          `${files.length} files / ${chars} ${caps.countMode} chars, caps are ` +
          `${caps.maxFilesPerUnit} files / ${caps.maxCharsPerUnit} chars`,
      })
    }
  }
  return findings
}
