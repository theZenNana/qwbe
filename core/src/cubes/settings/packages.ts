// The settings cube's package HTTP handlers.
//
// Split out of `index.ts` after the install-page feedback asked for package discovery
// (scan + multi-select install) on top of the QWB-15 install-from flow. `index.ts` was over
// its baseline with no headroom, so the split came first - the same procedure QWB-15 used
// when it pushed that file to 9670 characters. The seam is the one `commands.ts` already
// draws: everything that speaks for the PACKAGES endpoints lives here; index.ts keeps the
// group definition and the cube handlers.
//
// The installer is narrowed to `ScanInstaller` because scan and forget take a PATH - the
// capability `CubeInstaller` deliberately withholds from cubes. The narrowing is checked,
// not cast: a kernel that stops handing this capability over is a kernel bug, and failing
// at startup beats a 500 on the first click.

import { Effect } from "effect"
import type { CubeTools } from "qwbe-core/cube"
import { requirePermission } from "../../kernel/auth-contract.ts"
import { BadRequest } from "../../kernel/errors.ts"
import type { ScanInstaller } from "../../kernel/install-scan.ts"
import { assignCurrentUserCubeAdmin } from "./permissions.ts"
import { ROUTES } from "./routes.ts"

type Installer = NonNullable<CubeTools["installer"]>
type Catalogue = CubeTools["catalogue"]
type EntityPermissions = NonNullable<CubeTools["entityPermissions"]>

type Deps = Readonly<{
  catalogue: Catalogue
  installer: Installer
  entityPermissions: EntityPermissions
}>

const requireWrite = (route: keyof typeof ROUTES) => requirePermission(ROUTES[route])

export const packagesHandlers = ({ catalogue, installer, entityPermissions }: Deps) => {
  if (!("scanDirectory" in installer) || !("forgetShelf" in installer)) {
    throw new Error("settings missing kernel capabilities")
  }
  const pkgInstaller = installer as ScanInstaller

  return {
    packages: () =>
      Effect.gen(function* () {
        yield* requireWrite("packages")
        return pkgInstaller.available()
      }),

    install: ({ path }: { path: { name: string } }) =>
      Effect.gen(function* () {
        yield* requireWrite("install")
        // Every refusal from the installer already says what was refused and why --
        // unknown package, bad name, destination taken. Rewriting them into a generic
        // message would hide exactly the part the caller needs.
        const pkg = yield* pkgInstaller
          .install(path.name)
          .pipe(Effect.catchTag("InstallError", (e) => new BadRequest({ message: e.message })))
        yield* assignCurrentUserCubeAdmin(entityPermissions, pkg.cubes).pipe(Effect.orDie)
        // Not mounted yet: the kernel reads the disk at startup. Said in the response
        // rather than hoped for.
        return { package: pkg, requiresRestart: true }
      }),

    installFrom: ({ payload }: { payload: { path: string } }) =>
      Effect.gen(function* () {
        yield* requireWrite("installFrom")
        // Same pass-through as install: the kernel's refusals name the problem -
        // relative path, symlink in the tree, lying manifest, name clash. The CLI
        // command below calls this same function, so both surfaces speak identically.
        const result = yield* pkgInstaller
          .stageAndInstall(payload.path)
          .pipe(Effect.catchTag("InstallError", (e) => new BadRequest({ message: e.message })))
        yield* assignCurrentUserCubeAdmin(entityPermissions, result.cubes).pipe(Effect.orDie)
        const { staged, ...pkg } = result
        return { package: pkg, staged, requiresRestart: true }
      }),

    scanPackages: ({ payload }: { payload: { path: string } }) =>
      Effect.gen(function* () {
        yield* requireWrite("scanPackages")
        // Read-only reconnaissance: what would install-from accept from this directory,
        // and what does the store already hold against each candidate. The kernel's
        // refusals (relative path, missing directory) pass through unchanged.
        const packages = yield* pkgInstaller
          .scanDirectory(payload.path)
          .pipe(Effect.catchTag("InstallError", (e) => new BadRequest({ message: e.message })))
        return { packages: [...packages] }
      }),

    forgetShelf: ({ path }: { path: { name: string } }) =>
      Effect.gen(function* () {
        yield* requireWrite("forgetShelf")
        const result = yield* pkgInstaller
          .forgetShelf(path.name)
          .pipe(Effect.catchTag("InstallError", (e) => new BadRequest({ message: e.message })))
        // The store is not the running process: nothing mounted changes, nothing to restart.
        return { removed: result.removed, requiresRestart: false }
      }),

    uninstallPackage: ({ path }: { path: { name: string } }) =>
      Effect.gen(function* () {
        yield* requireWrite("uninstallPackage")
        // A package from the store cannot BE a required cube -- required ones ship with core
        // and are not in the store. Checked anyway rather than reasoned about, because that
        // sentence is true today and is exactly the kind that stops being true quietly.
        const mounted = catalogue()
          .filter((c) => c.required)
          .map((c) => c.name)
        const pkg = pkgInstaller.available().find((p) => p.name === path.name)
        const clash = (pkg?.cubes ?? []).filter((c) => mounted.includes(c))
        if (clash.length > 0) {
          return yield* Effect.fail(
            new BadRequest({ message: `Refused: that package holds required cube(s): ${clash.join(", ")}.` }),
          )
        }
        const result = yield* pkgInstaller
          .uninstallPackage(path.name)
          .pipe(Effect.catchTag("InstallError", (e) => new BadRequest({ message: e.message })))
        return { removed: result.removed, requiresRestart: true }
      }),
  }
}
