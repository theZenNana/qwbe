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

type Manifest = {
  readonly name?: unknown
  readonly kind?: unknown
  readonly cubes?: unknown
}

const BUILTIN_ROOTS = [
  "node:fs",
  "node:fs/promises",
  "node:child_process",
  "node:worker_threads",
  "node:module",
  "node:vm",
  "node:sqlite",
]

// Directories that are never package source. `frontend` is the pack's UI, judged by the
// browser build, not by the cube contract; `probes` runs in the authoring checkout by design.
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "frontend", "probes", "store", "dist", "build"])
const SOURCE_FILE = /\.(ts|tsx|mjs|js|jsx)$/
// Tests exercise the rules, so they may name the forbidden thing: a test file's job is to
// import node:fs or call writeFile to build a fixture. The rules below therefore judge
// everything EXCEPT test files; the internal-import rule has no such exception.
const TEST_FILE = /\.(test|spec)\.(ts|tsx|mjs|js|jsx)$/
const IMPORT_LINE = /^\s*import\b|\bimport\s*\(/

const isImportLine = (line: string): boolean => IMPORT_LINE.test(line)

export const walkSources = (root: string, current: string = root): string[] => {
  const found: string[] = []
  for (const entry of readdirSync(current, { withFileTypes: true })) {
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
  const onDisk = readdirSync(join(root, "cubes"), { withFileTypes: true })
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
    const text = readFileSync(file, "utf8")
    const relFile = rel(root, file)
    if (/(?:\.\.\/)+src\//.test(text) || /qwbe-core\/src\//.test(text)) {
      findings.push({
        rule: "imports-internal",
        file: relFile,
        message: "imports kernel internals; qwbe is reachable only through public qwbe-core/* subpaths",
      })
    }
    const inCube = (relFile === "cubes" || relFile.startsWith("cubes/")) && !TEST_FILE.test(relFile)
    if (!inCube) continue
    const imports = text.split("\n").filter(isImportLine).join("\n")
    for (const builtin of BUILTIN_ROOTS) {
      if (imports.includes(builtin)) {
        findings.push({ rule: "cube-builtins", file: relFile, message: `${builtin} imported by the cube` })
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
    const text = readFileSync(file, "utf8")
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
