// The filesystem half of the package contract: manifest vs disk, the import boundary, and
// the readOnly write-surface scan. Pure source reading -- no module execution. The orchestration
// and the hierarchy rule (which imports cube modules) live in `package-contract.ts`, which
// imports FROM here -- never the other way, or dependency-cruiser sees a cycle.

import { join, relative, sep } from "node:path"
import { FileSystem } from "@effect/platform"
import { Effect, Schema } from "effect"
import { subdirectories, walk } from "./files.ts"
import { specifiers, stripCode } from "./package-contract-lex.ts"
import type { PackageFinding } from "./package-finding.ts"
import { MANIFEST, PackageManifest } from "./package-source.ts"

export type { PackageFinding }

// Bare names, judged with and without the `node:` prefix (below): the kernel's own cruiser rule
// is written `^(node:)?(...)$` because a first attempt matching only `node:`-prefixed specifiers
// was half-open -- `import { readFileSync } from "fs"` slipped through (see the comment at
// `cubes-may-not-touch-storage-directly` in `core/.dependency-cruiser.cjs`). Depcruise never
// runs over a pack repo, so for a pack this checker is the only net; it must not be half-open.
// `net` and `http` are in the list: a cube reaches the network
// through the kernel's HTTP surface, never by opening its own socket or listening server.
const BUILTIN_ROOTS = ["fs", "fs/promises", "child_process", "worker_threads", "module", "vm", "sqlite", "net", "http"]

const isBuiltin = (specifier: string): boolean =>
  BUILTIN_ROOTS.some((b) => specifier === b || specifier === `node:${b}`)

// Directories that are never package source, honoured at the TOP level of the package only:
// `frontend` is the pack's UI, judged by the browser build, not by the cube contract; `probes`
// runs in the authoring checkout by design; `store`, `dist` and `build` are generated. Nested
// directories of these names are ordinary source -- a top-level-only exemption must not become
// a one-directory bypass (the size gate made exactly that mistake once).
const SKIP_DIRECTORIES = new Set(["frontend", "probes", "store", "dist", "build"])
const SOURCE_FILE = /\.(ts|tsx|mjs|js|jsx)$/
// Tests exercise the rules, so they may name the forbidden thing: a test file's job is to
// import node:fs or call writeFile to build a fixture. The rules below therefore judge
// everything EXCEPT test files; the internal-import rule has no such exception.
const TEST_FILE = /\.(test|spec)\.(ts|tsx|mjs|js|jsx)$/

export const walkSources = (root: string) =>
  Effect.map(
    walk(
      root,
      // Dotted directories and node_modules are never package source, at ANY depth: a stray
      // `.claude/` or a nested `node_modules/` raises findings the pack author cannot fix.
      (e) => e.name.startsWith(".") || e.name === "node_modules" || (e.top && SKIP_DIRECTORIES.has(e.name)),
    ),
    (entries) => entries.filter((e) => e.type !== "Directory" && SOURCE_FILE.test(e.name)).map((e) => e.path),
  )

const rel = (root: string, file: string): string => relative(root, file).split(sep).join("/")

const manifestFinding = (message: string, file = MANIFEST): PackageFinding => ({ rule: "manifest", file, message })

/** Cube directories under `cubesDir` that carry an index.ts: `name` and one level of `name/child`. */
const cubesOnDisk = (fs: FileSystem.FileSystem, cubesDir: string) =>
  Effect.gen(function* () {
    const names: string[] = []
    for (const top of yield* subdirectories(cubesDir)) {
      names.push(top, ...(yield* subdirectories(join(cubesDir, top))).map((n) => `${top}/${n}`))
    }
    return yield* Effect.filter(names, (name) => fs.exists(join(cubesDir, ...name.split("/"), "index.ts")))
  })

/**
 * Manifest vs disk, both directions. `cubesRoot` defaults to `root` and differs in exactly one
 * case: an INSTALLED package, whose manifest the installer keeps in the store and deliberately
 * does not copy next to the cubes (`isBookkeeping` in kernel/install.ts). Then the manifest is
 * read from the store copy and judged against the cubes that are really on the raft.
 */
export const manifestFindings = (root: string, cubesRoot: string = root) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const none: { findings: PackageFinding[]; cubes: string[] } = { findings: [], cubes: [] }
    const manifestPath = join(root, MANIFEST)
    if (!(yield* fs.exists(manifestPath)))
      return { ...none, findings: [manifestFinding("package manifest is missing")] }
    const decoded = yield* fs
      .readFileString(manifestPath)
      .pipe(Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(PackageManifest))), Effect.either)
    if (decoded._tag === "Left") {
      return { ...none, findings: [manifestFinding(`manifest does not decode: ${decoded.left.message}`)] }
    }
    const cubesDir = join(cubesRoot, "cubes")
    if (!(yield* fs.exists(cubesDir))) {
      return { ...none, findings: [manifestFinding("the cubes/ directory is missing", "cubes/")] }
    }
    const declared = decoded.right.cubes
    if (declared === undefined) {
      return { ...none, findings: [manifestFinding("manifest.cubes must be an array of cube names")] }
    }
    // Declared cubes must exist on disk, and cubes on disk must be declared. Both directions:
    // a manifest pointing at nothing installs air, an undeclared directory installs unreviewed.
    const onDisk = yield* cubesOnDisk(fs, cubesDir)
    const findings = [
      ...declared
        .filter((name) => !onDisk.includes(name))
        .map((name) => manifestFinding(`cube "${name}" is declared but has no cubes/${name}/index.ts on disk`)),
      ...onDisk
        .filter((name) => !declared.includes(name))
        .map((name) => manifestFinding("cube directory is not declared in the manifest", `cubes/${name}/index.ts`)),
    ]
    return { findings, cubes: [...declared] }
  })

/** A source file and its text, read once by the caller and judged by every rule below. */
export type Source = Readonly<{ file: string; text: string }>

export const importFindings = (root: string, sources: readonly Source[]): PackageFinding[] => {
  const findings: PackageFinding[] = []
  for (const source of sources) {
    const text = stripCode(source.text)
    const relFile = rel(root, source.file)
    // The deep-relative form is the exact shape a pack sitting beside the kernel checkout would
    // write: `../../../qwbe/core/src/kernel/discovery.ts` reaches internals through a `../` run
    // that does not have `src/` immediately after it.
    if (/(?:\.\.\/)+.*\/src\//.test(text) || /qwbe-core\/src\//.test(text)) {
      findings.push({
        rule: "imports-internal",
        file: relFile,
        message: "imports kernel internals; qwbe is reachable only through public qwbe-core/* subpaths",
      })
    }
    if (!relFile.startsWith("cubes/") || TEST_FILE.test(relFile)) continue
    for (const specifier of specifiers(text)) {
      if (isBuiltin(specifier)) {
        findings.push({ rule: "cube-builtins", file: relFile, message: `${specifier} imported by the cube` })
      }
    }
  }
  return findings
}

export const readOnlyFindings = (root: string, sources: readonly Source[]): PackageFinding[] => {
  const findings: PackageFinding[] = []
  for (const source of sources) {
    const relFile = rel(root, source.file)
    if (TEST_FILE.test(relFile)) continue
    const text = stripCode(source.text, true)
    for (const verb of [
      "HttpApiEndpoint.post",
      "HttpApiEndpoint.put",
      "HttpApiEndpoint.patch",
      "HttpApiEndpoint.del",
    ]) {
      if (text.includes(verb)) {
        findings.push({
          rule: "readonly-endpoint",
          file: relFile,
          message: `${verb} would let the package change state`,
        })
      }
    }
    for (const write of ["writeFile", "appendFile"]) {
      if (text.includes(write)) {
        findings.push({ rule: "readonly-write", file: relFile, message: `${write} writes to the filesystem` })
      }
    }
  }
  return findings
}
