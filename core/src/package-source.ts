import { createHash } from "node:crypto"
import { relative, sep } from "node:path"
import { FileSystem } from "@effect/platform"
import { Effect, Schema } from "effect"
import { walk } from "./files.ts"

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

/** The provenance file every staged shelf carries: where it came from and when. */
export const PROVENANCE = "qwbe-source.json"

/** The package manifest: what makes a directory a package (and what stays bookkeeping). */
export const MANIFEST = "qwbe-package.json"

/** The manifest's shape, decoded by both readers: the installer (kernel/install.ts) and the
 * package contract (package-contract-scan.ts). Each adds the rules only it cares about. */
export const PackageManifest = Schema.Struct({
  name: Schema.NonEmptyString,
  kind: Schema.optional(Schema.Literal("cube", "plugin")),
  summary: Schema.optional(Schema.String),
  cubes: Schema.optional(Schema.Array(Schema.String)),
})

/** Store bookkeeping files that are not part of the cube and never reach the destination:
 * one definition, shared by the install copy and the `qwbe check` sandbox copy. */
export const isBookkeeping = (src: string): boolean => src.endsWith(sep + MANIFEST) || src.endsWith(sep + PROVENANCE)

/** What a shelf's provenance records: the source directory, the content fingerprint at staging,
 * and the moment. Written by the staging flow, re-checked by store-drift against both sides. */
export const Provenance = Schema.Struct({
  sourcePath: Schema.String,
  fingerprint: Schema.String,
  stagedAt: Schema.optional(Schema.String),
})
export type Provenance = typeof Provenance.Type

/** The hash of every file under `dir` (path + sha256 of the bytes). Top-level `exclude`d names
 * (bookkeeping) never count. `skipLocalTooling` (the default) also skips top-level authoring
 * tooling (`isLocalSourceEntry`) -- the right rule for a SOURCE checkout. A shelf passes
 * `false`: staging never writes tooling into a shelf, so any foreign byte there is a manual
 * change and must change the hash -- that is the drift `qwbe drift` exists to catch. */
export const packageSourceFingerprint = (dir: string, exclude: readonly string[] = [], skipLocalTooling = true) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const entries = yield* walk(
      dir,
      (e) => e.top && (exclude.includes(e.name) || (skipLocalTooling && isLocalSourceEntry(e.name))),
    )
    const hashes = yield* Effect.forEach(
      entries.filter((e) => e.type !== "Directory"),
      (e) =>
        Effect.map(
          fs.readFile(e.path),
          (bytes) => `${relative(dir, e.path)}:${createHash("sha256").update(bytes).digest("hex")}`,
        ),
    )
    return createHash("sha256").update(hashes.sort().join("\n")).digest("hex")
  })

/** The shelf rule as ONE function: every reader that judges a store shelf copy (the drift
 * check, install-from reuse, the install scanner) hashes it through here -- strictly, nothing
 * skipped beyond the provenance file, because staging never writes tooling into a shelf. The
 * source side stays on `packageSourceFingerprint(dir)`: a live checkout legitimately carries
 * its tooling. package-source.test.ts pins every call site, so a reader re-deriving a shelf
 * hash by hand -- the lax regression review 14b found in the scanner -- fails there. */
export const shelfFingerprint = (dir: string) => packageSourceFingerprint(dir, [PROVENANCE], false)

/** The first entry that is not a plain file or directory, as a refusal fragment; undefined when clean. */
export const validatePackageSourceTree = (root: string) =>
  Effect.map(
    walk(root, (e) => e.top && isLocalSourceEntry(e.name)),
    (entries) => {
      const bad = entries.find((e) => e.type !== "File" && e.type !== "Directory")
      if (!bad) return undefined
      return bad.type === "SymbolicLink" ? `"${bad.path}" is a symlink` : `"${bad.path}" is a special file`
    },
  )
