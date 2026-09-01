// Installing and removing cubes -- the capability behind the install page.
//
// The invariant this file must not break is the one in `manifest.ts`:
//
//     ONE CUBE = ONE DIRECTORY. INSTALLING IT TOUCHES NO EXISTING FILE.
//
// So installing is literally copying a directory, and removing is deleting one. There is no
// registry to append to, no `cubes.ts` to edit, nothing to migrate. That is the whole point:
// if installation had to edit a shared file, two cubes installed by two people would conflict
// in that file, and "independent" would be a slogan.
//
// WHY THIS LIVES IN THE KERNEL, not in the settings cube:
//
// Cubes may not touch `node:fs` -- a boundary rule enforces it, because a cube with a filesystem
// handle can open another cube's database and the isolation story collapses. The settings cube
// is not exempt: a rule that carves out an exception for whoever enforces it stops being a rule.
// So the kernel owns the filesystem and hands out a NARROW capability, granted on the same
// declared basis as the switches (`managesCubes: true` in the manifest, at most one cube).
//
// WHAT THE CAPABILITY DELIBERATELY CANNOT DO -- this is the security surface, so it is written
// out rather than implied:
//
//   * It cannot copy from anywhere. Sources come only from the store directory, one level deep.
//   * It cannot write anywhere. Destinations are only `src/cubes/<name>` or `plugins/<name>`.
//   * It cannot be handed a path. It takes a NAME, matched against a strict pattern, and every
//     resolved path is re-checked to sit under its allowed root -- belt and braces, because the
//     pattern is the kind of thing that gets relaxed later by someone in a hurry.
//   * It cannot overwrite. An install onto an existing directory is refused, not merged: the
//     invariant says no existing file is touched, and a merge touches files.
//   * It cannot remove a required cube. Removing `auth` from a web page is the button that cuts
//     the branch it sits on.
//
// WHAT IT HONESTLY CANNOT PROMISE: the kernel discovers cubes at STARTUP. Writing the directory
// does not mount it. The caller is told `requiresRestart: true` rather than being shown a route
// list that is not live yet -- a page that lies about what happened is worse than one that asks
// you to restart.
//
// LAYOUT (split for the size cap): the path guards, allowed destinations and the Effect bridge
// live in `install-guards.ts`; the methods that look at the installed state (cubeOnDisk,
// remove, restart) in `install-lifecycle.ts`. This file keeps the store reader and the
// install/stage/uninstall engine.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { includePackageSourcePath, isBookkeeping, MANIFEST } from "../package-source.ts"
import { InstallError, stageAndInstall as stageAndInstallFor } from "./install-from.ts"
import {
  checkName,
  cubesDir,
  destinationOf,
  lifecycleInstaller,
  NAME,
  pluginsDir,
  srcDir,
  tried,
  triedPromise,
  under,
} from "./install-parts.ts"
import { forgetShelfFor, type ScanInstaller, scanFor } from "./install-scan.ts"
import type { CubePackage } from "./manifest.ts"

export { InstallError }

/** Where installable packages sit. Overridable so the probes can point at a scratch copy. */
const storeDir = resolve(process.env.QWBE_STORE_DIR ?? join(srcDir, "..", "store"))

/** The metadata file that makes a directory in the store a package rather than scratch. */

const sizeOf = (dir: string): number => {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    total += entry.isDirectory() ? sizeOf(p) : statSync(p).size
  }
  return total
}

/**
 * Every cube name currently on disk, wherever it came from.
 *
 * The kernel already refuses to start when two cubes share a name (`DuplicateCubeError`) -- that
 * rule is right, and it is what turned this into a real failure: two store packages both brought
 * a cube called `contacts`, install accepted the second, and the next startup died. The server
 * did not come up at all, which from a button in a web page is the worst outcome available.
 *
 * So the same question the kernel asks at startup gets asked one step earlier, at install time,
 * where it can still be answered with a refusal instead of a dead process.
 */
const cubesOnDisk = (): ReadonlyArray<{ cube: string; from: string }> => {
  const found: Array<{ cube: string; from: string }> = []
  const dirsIn = (d: string) =>
    existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()) : []

  for (const e of dirsIn(cubesDir)) found.push({ cube: e.name, from: "core" })
  for (const p of dirsIn(pluginsDir)) {
    for (const e of dirsIn(join(pluginsDir, p.name, "cubes"))) {
      found.push({ cube: e.name, from: `plugin ${p.name}` })
    }
  }
  return found
}

/**
 * Install a package the store already holds, by name. Shared by the store flow and by
 * stageAndInstall, which ends with the package on the raft and asks the very same question.
 */
const installExisting = (name: string): CubePackage => {
  const pkg = readPackage(name)
  const from = under(storeDir, join(storeDir, name))
  const to = destinationOf(pkg)

  if (existsSync(to)) {
    throw new InstallError(
      `refused: "${to.replace(srcDir, "src")}" already exists. ` +
        `Installing never overwrites - remove it first if that is what you meant.`,
    )
  }

  // Refused here rather than discovered at the next startup. The kernel's duplicate-name rule
  // is correct and fatal, so letting the copy through would trade a clear "no" for a server
  // that will not come up - and the person who clicked would have no way to connect the two.
  const clash = cubesOnDisk().filter((c) => pkg.cubes.includes(c.cube))
  if (clash.length > 0) {
    throw new InstallError(
      `refused: "${name}" brings ${clash.map((c) => `"${c.cube}"`).join(", ")}, ` +
        `already on disk (${clash.map((c) => c.from).join(", ")}). ` +
        `Two cubes cannot share a name - the server would refuse to start at all. ` +
        `Remove the other one first if this is the one you want.`,
    )
  }

  mkdirSync(dirname(to), { recursive: true })
  // The package manifest and the provenance file are store bookkeeping, not part of the
  // cube. Copying them would put files inside the installed directory that the cube itself
  // never declared.
  //
  // A failed copy must not leave a partial destination: half a cube on disk would be
  // discovered at the next boot as if it were whole. The destination is one directory and
  // this operation created it, so removing it is the rollback, not a deletion of anyone
  // else's work.
  try {
    // The one content rule (package-source.ts): what staging ships, minus bookkeeping. The
    // `qwbe check` sandbox copy uses the same two predicates -- install-filters.test.ts
    // fails the day the two copies diverge again.
    cpSync(from, to, {
      recursive: true,
      filter: (src) => includePackageSourcePath(from, src) && !isBookkeeping(src),
    })
  } catch (e) {
    rmSync(to, { recursive: true, force: true })
    throw e
  }

  return { ...pkg, installed: true }
}

const readPackageAt = (name: string, dir: string): CubePackage => {
  checkName("package", name)
  const manifestPath = join(dir, MANIFEST)
  if (!existsSync(manifestPath)) {
    throw new InstallError(`refused: "${name}" is not a package - no ${MANIFEST} in the directory`)
  }

  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    name?: string
    kind?: string
    summary?: string
    cubes?: Array<string>
  }

  if (raw.name !== name) {
    // A package whose manifest names something else would install under one name and appear
    // under another -- the first step of shadowing an existing cube.
    throw new InstallError(`refused: package directory "${name}" declares name "${raw.name}"`)
  }
  if (raw.kind !== "cube" && raw.kind !== "plugin") {
    throw new InstallError(`refused: package "${name}" declares kind "${raw.kind}" -- expected cube or plugin`)
  }

  const cubes = raw.kind === "plugin" ? (raw.cubes ?? []) : [name]
  for (const c of cubes) checkName("cube", c)

  // The manifest PROMISES cubes; the directory must actually carry them. A plugin declaring
  // `cubes: ["ghost"]` without `cubes/ghost/` would stage cleanly and fail at the next boot,
  // where the refusal reads as a broken server rather than a bad package.
  if (raw.kind === "plugin") {
    for (const c of cubes) {
      if (!existsSync(join(dir, "cubes", c))) {
        throw new InstallError(`refused: plugin "${name}" declares cube "${c}" but has no cubes/${c}/ directory.`)
      }
    }
  } else if (!existsSync(join(dir, "index.ts")) && !existsSync(join(dir, "index.tsx"))) {
    throw new InstallError(`refused: cube package "${name}" has no index.ts at its root.`)
  }

  const kind = raw.kind
  const installed = existsSync(destinationOf({ name, kind }))
  // A package already installed does not "conflict with itself" -- its own cubes are on disk
  // precisely because it put them there.
  const mine = new Set(installed ? cubes : [])
  const taken = cubesOnDisk()
    .filter((c) => !mine.has(c.cube))
    .map((c) => c.cube)

  return {
    name,
    kind,
    summary: raw.summary ?? "",
    cubes,
    installed,
    bytes: sizeOf(dir),
    conflicts: cubes.filter((c) => taken.includes(c)),
  }
}

const readPackage = (name: string): CubePackage => readPackageAt(name, under(storeDir, join(storeDir, name)))

export const installerFor = (): ScanInstaller => {
  const stageAndInstallFrom = stageAndInstallFor({ storeDir, readPackageAt, installExisting })
  const scanContext = { storeDir, readPackageAt }

  return {
    ...lifecycleInstaller(),

    uninstallPackage: (name: string) =>
      tried(() => {
        const pkg = readPackage(name)
        const to = destinationOf(pkg)
        if (!existsSync(to)) {
          throw new InstallError(`refused: "${name}" is not installed -- nothing at "${to.replace(srcDir, "src")}"`)
        }
        rmSync(to, { recursive: true, force: true })
        return { removed: to.replace(resolve(srcDir, ".."), "."), cubes: pkg.cubes }
      }),

    available: () => {
      if (!existsSync(storeDir)) return []
      return readdirSync(storeDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && NAME.test(e.name))
        .flatMap((e) => {
          try {
            return [readPackage(e.name)]
          } catch {
            // A malformed package in the store must not take the whole list down -- the page has
            // to keep working so you can install the ones that are fine.
            return []
          }
        })
        .sort((a, b) => a.name.localeCompare(b.name))
    },

    install: (name: string) => tried(() => installExisting(name)),

    stageAndInstall: (sourceDirectory: string) => triedPromise(() => stageAndInstallFrom(sourceDirectory)),

    scanDirectory: (directory: string) => tried(() => scanFor(scanContext)(directory)),

    forgetShelf: (name: string) => tried(() => forgetShelfFor(scanContext)(name)),
  }
}
