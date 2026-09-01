import { createHash } from "node:crypto"
import { lstatSync, readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"

// `frontend` belongs here for the same reason `probes` does: it is the authoring checkout's own
// tooling, not part of the installable package. The contract scanner already skips it
// (`package-contract-scan.ts`, SKIP_DIRECTORIES); without the same entry here the installer copied
// a pack's whole `frontend/`, walked into `frontend/node_modules/.bin` and refused the install on
// the first symlink it found - so a pack whose frontend had ever been installed could not be
// installed at all. `dist` and `build` follow the scanner for the same reason.
// Hidden entries (`.pi`, `.claude`, `.githooks`, ...) are the authoring checkout's agent and git
// tool state - the same family as `node_modules`, never package content. They are skipped by the
// leading-dot rule below rather than by name, so the next tool's directory ships no surprises.
const LOCAL_SOURCE_DIRECTORIES = new Set(["node_modules", "docs", "probes", "test", "frontend", "dist", "build"])
const LOCAL_SOURCE_FILES = new Set(["package.json", "package-lock.json", "tsconfig.json"])
const LOCAL_SOURCE_FILE_PATTERN = /\.(test|spec)\.(mjs|js|jsx)$/
const PACKAGE_NAME = /^[a-z][a-z0-9-]{0,31}$/

/** Installable identities are standalone slugs or one parent/child pair. */
export const isPackageCubeIdentity = (name: string): boolean => {
  const segments = name.split("/")
  return (segments.length === 1 || segments.length === 2) && segments.every((segment) => PACKAGE_NAME.test(segment))
}

/** Local tooling belongs to the authoring checkout, never to the installable package. */
export const isLocalSourceDirectory = (name: string): boolean =>
  name.startsWith(".") || LOCAL_SOURCE_DIRECTORIES.has(name)

const isLocalSourceEntry = (name: string): boolean =>
  name.startsWith(".") ||
  isLocalSourceDirectory(name) ||
  LOCAL_SOURCE_FILES.has(name) ||
  LOCAL_SOURCE_FILE_PATTERN.test(name)

export const includePackageSourcePath = (root: string, path: string): boolean =>
  path === root || !isLocalSourceEntry(relative(root, path).split(sep)[0] ?? "")

/** The provenance file every staged shelf carries: where it came from and when (QWB-54 ticket 22). */
export const PROVENANCE = "qwbe-source.json"

/** The package manifest: what makes a directory a package (and what stays bookkeeping). */
export const MANIFEST = "qwbe-package.json"

/** Store bookkeeping files that are not part of the cube and never reach the destination:
 * one definition, shared by the install copy and the `qwbe check` sandbox copy. */
export const isBookkeeping = (src: string): boolean => src.endsWith(sep + MANIFEST) || src.endsWith(sep + PROVENANCE)

/** What a shelf's provenance records: the source directory, the content fingerprint at staging,
 * and the moment. Written by the staging flow, re-checked by store-drift against both sides. */
export type Provenance = Readonly<{
  sourcePath: string
  fingerprint: string
  stagedAt: string
}>

/** The hash of every file under `dir` (path + sha256 of the bytes). Top-level `exclude`d names
 * (bookkeeping) never count. `skipLocalTooling` (the default) also skips top-level authoring
 * tooling (`isLocalSourceEntry`) -- the right rule for a SOURCE checkout. A shelf passes
 * `false`: staging never writes tooling into a shelf, so any foreign byte there is a manual
 * change and must change the hash -- that is the drift `qwbe drift` exists to catch. */
export const packageSourceFingerprint = (
  dir: string,
  exclude: readonly string[] = [],
  skipLocalTooling = true,
): string => {
  const entries: string[] = []
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (current === dir && (exclude.includes(entry.name) || (skipLocalTooling && isLocalSourceEntry(entry.name))))
        continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else entries.push(`${relative(dir, path)}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`)
    }
  }
  walk(dir)
  return createHash("sha256").update(entries.sort().join("\n")).digest("hex")
}

export const validatePackageSourceTree = (root: string): string | undefined => {
  const walk = (current: string): string | undefined => {
    for (const entry of readdirSync(current)) {
      if (current === root && isLocalSourceEntry(entry)) continue
      const path = join(current, entry)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) return `"${path}" is a symlink`
      if (!stat.isFile() && !stat.isDirectory()) return `"${path}" is a special file`
      if (stat.isDirectory()) {
        const invalid = walk(path)
        if (invalid) return invalid
      }
    }
    return undefined
  }
  return walk(root)
}
