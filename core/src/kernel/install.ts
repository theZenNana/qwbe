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
// LAYOUT (split for the size cap): the path guards, allowed destinations and the Effect face
// live in `install-parts.ts`, with the methods that look at the installed state (cubeOnDisk,
// remove, restart). This file keeps the store reader and the install/stage/uninstall engine.

import { dirname, join, resolve } from "node:path"
import { FileSystem } from "@effect/platform"
import { Effect, Schema } from "effect"
import { QwbeConfig, type QwbeSettings } from "../config.ts"
import { copyTree, subdirectories, walk } from "../files.ts"
import { includePackageSourcePath, isBookkeeping, MANIFEST, PackageManifest } from "../package-source.ts"
import { InstallError, stageAndInstall as stageAndInstallFor } from "./install-from.ts"
import {
  checkName,
  cubesDir,
  destinationOf,
  face,
  type InstallStep,
  lifecycleInstaller,
  NAME,
  srcDir,
  under,
} from "./install-parts.ts"
import { forgetShelfFor, type ScanInstaller, scanFor } from "./install-scan.ts"
import type { CubePackage } from "./manifest.ts"

export { InstallError }

/** Where installable packages sit. Overridable (QWBE_STORE_DIR) so the probes can point at a scratch copy. */
const storeDirOf = (config: QwbeSettings) => resolve(config.storeDir ?? join(srcDir, "..", "store"))

const sizeOf = (dir: string) =>
  Effect.map(walk(dir), (entries) => entries.reduce((total, e) => (e.type === "Directory" ? total : total + e.size), 0))

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
const cubesOnDisk = Effect.gen(function* () {
  const { pluginsDir } = yield* QwbeConfig
  const found: Array<{ cube: string; from: string }> = []
  for (const cube of yield* subdirectories(cubesDir)) found.push({ cube, from: "core" })
  for (const p of yield* subdirectories(pluginsDir)) {
    for (const cube of yield* subdirectories(join(pluginsDir, p, "cubes"))) {
      found.push({ cube, from: `plugin ${p}` })
    }
  }
  return found
})

/**
 * Install a package the store already holds, by name. Shared by the store flow and by
 * stageAndInstall, which ends with the package on the raft and asks the very same question.
 */
const installExisting = (name: string): InstallStep<CubePackage> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pkg = yield* readPackage(name)
    const storeDir = storeDirOf(yield* QwbeConfig)
    const from = yield* under(storeDir, join(storeDir, name))
    const to = yield* destinationOf(pkg)

    if (yield* fs.exists(to)) {
      return yield* new InstallError(
        `refused: "${to.replace(srcDir, "src")}" already exists. ` +
          `Installing never overwrites - remove it first if that is what you meant.`,
      )
    }

    // Refused here rather than discovered at the next startup. The kernel's duplicate-name rule
    // is correct and fatal, so letting the copy through would trade a clear "no" for a server
    // that will not come up - and the person who clicked would have no way to connect the two.
    const clash = (yield* cubesOnDisk).filter((c) => pkg.cubes.includes(c.cube))
    if (clash.length > 0) {
      return yield* new InstallError(
        `refused: "${name}" brings ${clash.map((c) => `"${c.cube}"`).join(", ")}, ` +
          `already on disk (${clash.map((c) => c.from).join(", ")}). ` +
          `Two cubes cannot share a name - the server would refuse to start at all. ` +
          `Remove the other one first if this is the one you want.`,
      )
    }

    yield* fs.makeDirectory(dirname(to), { recursive: true })
    // The package manifest and the provenance file are store bookkeeping, not part of the
    // cube. Copying them would put files inside the installed directory that the cube itself
    // never declared.
    //
    // A failed copy must not leave a partial destination: half a cube on disk would be
    // discovered at the next boot as if it were whole. The destination is one directory and
    // this operation created it, so removing it is the rollback, not a deletion of anyone
    // else's work.
    //
    // The one content rule (package-source.ts): what staging ships, minus bookkeeping. The
    // `qwbe check` sandbox copy uses the same two predicates -- install-filters.test.ts
    // fails the day the two copies diverge again.
    yield* copyTree(from, to, (src) => includePackageSourcePath(from, src) && !isBookkeeping(src)).pipe(
      Effect.onError(() => fs.remove(to, { recursive: true, force: true }).pipe(Effect.ignore)),
    )

    return { ...pkg, installed: true }
  })

const readPackageAt = (name: string, dir: string): InstallStep<CubePackage> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* checkName("package", name)
    const manifestPath = join(dir, MANIFEST)
    if (!(yield* fs.exists(manifestPath))) {
      return yield* new InstallError(`refused: "${name}" is not a package - no ${MANIFEST} in the directory`)
    }

    // A malformed manifest is a BAD PACKAGE, not a disk error: it must stay on the contract
    // channel (400 naming the problem), so the decode is classified here rather than left to
    // the face, which would turn it into a 500 (QWB-38). Only the DECODE is classified: the
    // read itself stays outside, so an IO error on the manifest file (EACCES, EISDIR) remains a
    // system error and answers 500, not a package refusal.
    const text = yield* fs.readFileString(manifestPath)
    const raw = yield* Schema.decodeUnknown(Schema.parseJson(PackageManifest))(text).pipe(
      Effect.mapError(
        (e) => new InstallError(`refused: package "${name}" has a manifest that does not decode: ${e.message}`),
      ),
    )

    if (raw.name !== name) {
      // A package whose manifest names something else would install under one name and appear
      // under another -- the first step of shadowing an existing cube.
      return yield* new InstallError(`refused: package directory "${name}" declares name "${raw.name}"`)
    }
    const kind = raw.kind
    if (kind === undefined) {
      return yield* new InstallError(`refused: package "${name}" declares no kind -- expected cube or plugin`)
    }

    const cubes = kind === "plugin" ? (raw.cubes ?? []) : [name]
    for (const c of cubes) yield* checkName("cube", c)

    // The manifest PROMISES cubes; the directory must actually carry them. A plugin declaring
    // `cubes: ["ghost"]` without `cubes/ghost/` would stage cleanly and fail at the next boot,
    // where the refusal reads as a broken server rather than a bad package.
    if (kind === "plugin") {
      for (const c of cubes) {
        if (!(yield* fs.exists(join(dir, "cubes", c)))) {
          return yield* new InstallError(
            `refused: plugin "${name}" declares cube "${c}" but has no cubes/${c}/ directory.`,
          )
        }
      }
    } else if (!(yield* fs.exists(join(dir, "index.ts"))) && !(yield* fs.exists(join(dir, "index.tsx")))) {
      return yield* new InstallError(`refused: cube package "${name}" has no index.ts at its root.`)
    }

    const installed = yield* fs.exists(yield* destinationOf({ name, kind }))
    // A package already installed does not "conflict with itself" -- its own cubes are on disk
    // precisely because it put them there.
    const mine = new Set(installed ? cubes : [])
    const taken = (yield* cubesOnDisk).filter((c) => !mine.has(c.cube)).map((c) => c.cube)

    return {
      name,
      kind,
      summary: raw.summary ?? "",
      cubes,
      installed,
      bytes: yield* sizeOf(dir),
      conflicts: cubes.filter((c) => taken.includes(c)),
    }
  })

const readPackage = (name: string) =>
  Effect.flatMap(QwbeConfig, (config) => {
    const storeDir = storeDirOf(config)
    return Effect.flatMap(under(storeDir, join(storeDir, name)), (dir) => readPackageAt(name, dir))
  })

export const installerFor = (
  /** Injected by discovery.ts, the only module allowed to run the source checker (QWB-70). Required. */
  checkPackageSource: (source: string) => Promise<ReadonlyArray<{ rule: string; file: string; message: string }>>,
  /** The config the server booted with: store, plugins directory, restart mode. */
  config: QwbeSettings,
): ScanInstaller => {
  const storeDir = storeDirOf(config)
  const run = <A>(step: InstallStep<A>) => face(config, step)
  const stageAndInstallFrom = stageAndInstallFor({
    storeDir,
    readPackageAt,
    installExisting,
    checkPackageSource,
  })
  const scanContext = { storeDir, readPackageAt }

  return {
    ...lifecycleInstaller(config),

    uninstallPackage: (name: string) =>
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const pkg = yield* readPackage(name)
          const to = yield* destinationOf(pkg)
          if (!(yield* fs.exists(to))) {
            return yield* new InstallError(
              `refused: "${name}" is not installed -- nothing at "${to.replace(srcDir, "src")}"`,
            )
          }
          yield* fs.remove(to, { recursive: true })
          return { removed: to.replace(resolve(srcDir, ".."), "."), cubes: pkg.cubes }
        }),
      ),

    available: () =>
      run(
        Effect.gen(function* () {
          const names = (yield* subdirectories(storeDir)).filter((n) => NAME.test(n))
          // A malformed package in the store must not take the whole list down -- the page has
          // to keep working so you can install the ones that are fine.
          const packages = yield* Effect.forEach(names, (n) => Effect.option(readPackage(n)))
          return packages
            .flatMap((p) => (p._tag === "Some" ? [p.value] : []))
            .sort((a, b) => a.name.localeCompare(b.name))
        }),
      ).pipe(Effect.orDie),

    install: (name: string) => run(installExisting(name)),

    stageAndInstall: (sourceDirectory: string) => run(stageAndInstallFrom(sourceDirectory)),

    scanDirectory: (directory: string) => run(scanFor(scanContext)(directory)),

    forgetShelf: (name: string) => run(forgetShelfFor(scanContext)(name)),
  }
}
