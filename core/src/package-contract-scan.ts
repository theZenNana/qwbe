// The filesystem half of the package contract: manifest vs disk, the import boundary, and
// the readOnly write-surface scan. Pure source reading -- no module execution. The orchestration
// and the hierarchy rule (which imports cube modules) live in `package-contract.ts`, which
// imports FROM here -- never the other way, or dependency-cruiser sees a cycle.

/** One broken rule in one file. `rule` is a stable id a pack can filter on. */
export type PackageFinding = {
  readonly rule: string
  readonly file: string
  readonly message: string
}

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"

import { specifiers, stripCode } from "./package-contract-lex.ts"

type Manifest = {
  readonly name?: unknown
  readonly kind?: unknown
  readonly cubes?: unknown
}

// Bare names, judged with and without the `node:` prefix (below): the kernel's own cruiser rule
// is written `^(node:)?(...)$` because a first attempt matching only `node:`-prefixed specifiers
// was half-open -- `import { readFileSync } from "fs"` slipped through (see the comment at
// `cubes-may-not-touch-storage-directly` in `core/.dependency-cruiser.cjs`). Depcruise never
// runs over a pack repo, so for a pack this checker is the only net; it must not be half-open.
// `net` and `http` joined the list with the boot gate (QWB-54): a cube reaches the network
// through the kernel's HTTP surface, never by opening its own socket or listening server.
const BUILTIN_ROOTS = [
  "fs",
  "fs/promises",
  "child_process",
  "worker_threads",
  "module",
  "vm",
  "sqlite",
  "net",
  "http",
]

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

export const walkSources = (root: string, current: string = root): string[] => {
  const found: string[] = []
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    // Dotted directories and node_modules are never package source, at ANY depth: a stray
    // `.claude/` or a nested `node_modules/` raises findings the pack author cannot fix.
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue
    if (current === root && SKIP_DIRECTORIES.has(entry.name)) continue
    const path = join(current, entry.name)
    if (entry.isDirectory()) found.push(...walkSources(root, path))
    else if (SOURCE_FILE.test(entry.name)) found.push(path)
  }
  return found
}

const rel = (root: string, file: string): string => relative(root, file).split(sep).join("/")

export const manifestFindings = (root: string): { findings: PackageFinding[]; cubes: string[] } => {
  const findings: PackageFinding[] = []
  const manifestPath = join(root, "qwbe-package.json")
  if (!existsSync(manifestPath)) {
    return {
      findings: [{ rule: "manifest", file: "qwbe-package.json", message: "package manifest is missing" }],
      cubes: [],
    }
  }
  let manifest: Manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest
  } catch (error) {
    return {
      findings: [
        { rule: "manifest", file: "qwbe-package.json", message: `manifest is not valid JSON: ${String(error)}` },
      ],
      cubes: [],
    }
  }
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    findings.push({ rule: "manifest", file: "qwbe-package.json", message: "manifest.name must be a non-empty string" })
  }
  if (manifest.kind !== undefined && (typeof manifest.kind !== "string" || manifest.kind.length === 0)) {
    findings.push({
      rule: "manifest",
      file: "qwbe-package.json",
      message: "manifest.kind must be a non-empty string when present",
    })
  }
  const cubesDir = join(root, "cubes")
  if (!existsSync(cubesDir)) {
    findings.push({ rule: "manifest", file: "cubes/", message: "the cubes/ directory is missing" })
    return { findings, cubes: [] }
  }
  const cubes = manifest.cubes
  if (!Array.isArray(cubes) || cubes.some((c) => typeof c !== "string")) {
    findings.push({
      rule: "manifest",
      file: "qwbe-package.json",
      message: "manifest.cubes must be an array of cube names",
    })
    return { findings, cubes: [] }
  }
  // Declared cubes must exist on disk, and cubes on disk must be declared. Both directions:
  // a manifest pointing at nothing installs air, an undeclared directory installs unreviewed.
  const onDisk = readdirSync(cubesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) => {
      const nested = readdirSync(join(root, "cubes", e.name), { withFileTypes: true })
        .filter((n) => n.isDirectory())
        .map((n) => `${e.name}/${n.name}`)
      return [e.name, ...nested]
    })
    .filter((name) => existsSync(join(root, "cubes", ...name.split("/"), "index.ts")))
  const declared = cubes as string[]
  for (const name of declared) {
    if (!onDisk.includes(name)) {
      findings.push({
        rule: "manifest",
        file: "qwbe-package.json",
        message: `cube "${name}" is declared but has no cubes/${name}/index.ts on disk`,
      })
    }
  }
  for (const name of onDisk) {
    if (!declared.includes(name)) {
      findings.push({
        rule: "manifest",
        file: `cubes/${name}/index.ts`,
        message: `cube directory is not declared in the manifest`,
      })
    }
  }
  return { findings, cubes: declared }
}

export const importFindings = (root: string, files: readonly string[]): PackageFinding[] => {
  const findings: PackageFinding[] = []
  for (const file of files) {
    const text = stripCode(readFileSync(file, "utf8"))
    const relFile = rel(root, file)
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

export const readOnlyFindings = (root: string, files: readonly string[]): PackageFinding[] => {
  const findings: PackageFinding[] = []
  for (const file of files) {
    const relFile = rel(root, file)
    if (TEST_FILE.test(relFile)) continue
    const text = stripCode(readFileSync(file, "utf8"), true)
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
