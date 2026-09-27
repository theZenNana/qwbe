// Scanning a directory for installable packages, and forgetting a store shelf copy.
//
// Split into its own file for the size cap and for the seam it keeps: both operations start
// from a PATH an administrator pointed at - the same administrative exception that
// `install-from.ts` guards - but neither copies or installs anything. Scan is read-only
// reconnaissance for the install page; forget removes a store shelf copy, the store-side
// operation that previously had no API.
//
// The two methods deliberately live OUTSIDE `CubeInstaller`: that type promises cubes a
// world without paths, and scan returns paths. Settings narrows to `ScanInstaller` at
// runtime, exactly like it already guards for its other kernel capabilities.

import { isAbsolute, join } from "node:path"
import { FileSystem } from "@effect/platform"
import { Effect } from "effect"
import { subdirectories } from "../files.ts"
import { MANIFEST, packageSourceFingerprint, shelfFingerprint } from "../package-source.ts"
import { checkName, destinationOf, type InstallStep, under } from "./install-parts.ts"
import type { CubeInstaller, CubePackage } from "./manifest.ts"
import { InstallError } from "./manifest.ts"

/** What the store knows about a scanned package's shelf copy. */
type ShelfState = "absent" | "identical" | "different"

type ScannedPackage = CubePackage & Readonly<{ path: string; shelf: ShelfState }>

/** `CubeInstaller` plus the two path-taking operations only settings is allowed to call. */
export type ScanInstaller = CubeInstaller & {
  readonly scanDirectory: (directory: string) => Effect.Effect<ReadonlyArray<ScannedPackage>, InstallError>
  readonly forgetShelf: (name: string) => Effect.Effect<{ readonly removed: string }, InstallError>
}

/** What scan and forget need from the store flow - handed in, not imported. */
type ScanContext = Readonly<{
  storeDir: string
  readPackageAt: (name: string, dir: string) => InstallStep<CubePackage>
}>

/**
 * One level of `directory`: every subdirectory that carries a `qwbe-package.json` and reads
 * as a valid package. Malformed candidates are skipped, not fatal - the same leniency the
 * store's `available()` already has, so one bad directory cannot take the installer page down.
 *
 * For each candidate the shelf state is decided by FINGERPRINT, never by path: identical
 * bytes mean install-from will reuse the copy, different bytes mean it will refuse until the
 * shelf is forgotten. That is the fact the UI needs to show before the user clicks. The shelf
 * side hashes through `shelfFingerprint` -- the exact rule install-from and `qwbe drift`
 * apply -- so all three readers answer a poisoned shelf the same way.
 */
export const scanFor =
  (ctx: ScanContext) =>
  (directory: string): InstallStep<ScannedPackage[]> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      if (!isAbsolute(directory)) {
        return yield* new InstallError(`refused: "${directory}" is not an absolute path`)
      }
      const isDirectory = yield* fs.stat(directory).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      )
      if (!isDirectory) {
        return yield* new InstallError(`refused: "${directory}" is not an existing directory`)
      }
      const root = yield* fs.realPath(directory)
      const found: ScannedPackage[] = []
      for (const name of yield* subdirectories(root)) {
        const dir = join(root, name)
        if (!(yield* fs.exists(join(dir, MANIFEST)))) continue
        const scanned = yield* Effect.gen(function* () {
          const pkg = yield* ctx.readPackageAt(name, dir)
          const shelfDir = join(ctx.storeDir, name)
          const shelf: ShelfState = !(yield* fs.exists(shelfDir))
            ? "absent"
            : (yield* shelfFingerprint(shelfDir)) === (yield* packageSourceFingerprint(dir))
              ? "identical"
              : "different"
          return { ...pkg, path: dir, shelf }
        }).pipe(Effect.option)
        // Not a package (no manifest readable, lying name, missing cube directory) - not a
        // scan failure. The next directory may be one.
        if (scanned._tag === "Some") found.push(scanned.value)
      }
      return found.sort((a, b) => a.name.localeCompare(b.name))
    })

/**
 * Remove a shelf copy the store holds. Refuses while the package is installed: the shelf is
 * what makes a reinstall possible WITHOUT the source path, and deleting both at once would
 * leave the operator with neither. The install page chains uninstall -> forget -> install
 * when it replaces a package from a source directory.
 */
export const forgetShelfFor =
  (ctx: ScanContext) =>
  (name: string): InstallStep<{ readonly removed: string }> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* checkName("package", name)
      const shelf = yield* under(ctx.storeDir, join(ctx.storeDir, name))
      if (!(yield* fs.exists(shelf))) {
        return yield* new InstallError(`refused: the store holds no package "${name}"`)
      }
      if (yield* fs.exists(yield* destinationOf(yield* ctx.readPackageAt(name, shelf)))) {
        return yield* new InstallError(
          `refused: "${name}" is installed. Remove the installed package first; ` +
            `forgetting the shelf is for copies nothing is installed from.`,
        )
      }
      yield* fs.remove(shelf, { recursive: true })
      return { removed: shelf }
    })
