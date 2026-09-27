// Measuring a PACKAGE against the kernel's size caps, for `qwbe check`.
//
// The caps live in the kernel's qwbe.config.json. A pack is measured by those numbers, never by
// numbers of its own: that is the whole point of the check command -- a pack cannot write its own
// rules.
//
// One unit is one cube directory: a pack's `cubes/` children, walked recursively. Exemptions:
// tests do not count, `node_modules` and friends are
// skipped at any depth, and a `frontend/` nested INSIDE a cube counts like any other source --
// only the pack's TOP-level `frontend/` is outside the contract, and this walk never
// starts there.

import { join, sep } from "node:path"
import { FileSystem } from "@effect/platform"
import { Effect, Schema } from "effect"
import { subdirectories, walk } from "./files.ts"
import { stripCode } from "./package-contract-lex.ts"
import type { PackageFinding } from "./package-finding.ts"

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
export const IS_TEST = /\.(test|spec)\.(ts|tsx|mjs|js|jsx)$/

export const posix = (p: string): string => p.split(sep).join("/")

/** The source files of one unit. A directory that cannot be read measures nothing. */
export const sourceFiles = (dir: string, { includeTests = false, top = true } = {}) =>
  walk(
    dir,
    // `frontend` at the TOP of the walk is the pack's UI, outside the cube contract.
    // Nested `frontend/` counts like any other source -- a one-directory bypass across the
    // whole tree would be exactly the hole the kernel's own gate once had.
    (e) => e.name.startsWith(".") || SKIP_DIR.has(e.name) || (top && e.top && e.name === "frontend"),
  ).pipe(
    Effect.map((entries) =>
      entries
        .filter((e) => e.type !== "Directory" && SOURCE.test(e.name) && (includeTests || !IS_TEST.test(e.name)))
        .map((e) => e.path),
    ),
    Effect.orElseSucceed((): string[] => []),
  )

/**
 * Strip comments so the cap can measure code: the contract's lexer (package-contract-lex.ts),
 * plus the blank lines removed comments leave behind, which are not code either.
 */
export const stripComments = (source: string): string =>
  stripCode(source)
    .split("\n")
    .filter((l) => l.trim() !== "")
    .join("\n")

const measure = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(file)).pipe(
    Effect.map((source) => ({ raw: source.length, code: stripComments(source).length })),
  )

const Cap = Schema.Number.pipe(Schema.finite(), Schema.positive())

/** The caps section of the kernel's qwbe.config.json. Unknown keys (`_comment`) are ignored. */
const SizeConfig = Schema.Struct({
  countMode: Schema.optional(Schema.Unknown),
  caps: Schema.Struct({ maxCharsPerFile: Cap, maxFilesPerUnit: Cap, maxCharsPerUnit: Cap }),
})

export type RawConfig = typeof SizeConfig.Encoded

/** The caps a pack is judged against, read from the installed kernel's qwbe.config.json. */
export type SizeCaps = {
  readonly countMode: "code" | "raw"
  readonly maxCharsPerFile: number
  readonly maxFilesPerUnit: number
  readonly maxCharsPerUnit: number
}

/** Decode the caps section. A wrong number here is a kernel problem (a ParseError naming the
 * key), not a finding. */
export const capsFromConfig = (config: unknown) =>
  Effect.map(
    Schema.decodeUnknown(SizeConfig)(config),
    ({ countMode, caps }): SizeCaps => ({ countMode: countMode === "raw" ? "raw" : "code", ...caps }),
  )

const children = (dir: string) =>
  subdirectories(dir).pipe(
    Effect.map((names) => names.filter((n) => !n.startsWith(".")).sort()),
    Effect.orElseSucceed((): string[] => []),
  )

/**
 * Judge a package's cubes against the caps. Units are the direct children of `<root>/cubes/`,
 * the units of an installed pack. No baseline: a pack gets the caps and nothing else, so
 * anything over cap is a finding.
 */
export const sizeCapsFindings = (root: string, caps: SizeCaps) =>
  Effect.gen(function* () {
    const findings: PackageFinding[] = []
    for (const name of yield* children(join(root, "cubes"))) {
      const files = yield* sourceFiles(join(root, "cubes", name), { top: false })
      let chars = 0
      for (const file of files) {
        const m = yield* measure(file)
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
  })
