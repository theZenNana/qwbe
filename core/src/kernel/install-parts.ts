// The installer's leaf internals, split out of `install.ts` for the per-file size cap:
// the path guards and allowed destinations, the package-independent lifecycle methods
// (cubeOnDisk, remove, restart), and the Effect bridge that turns strict TypeScript throws
// into `InstallError` on the error channel. Everything here imports from the
// manifest and the package grammar; nothing imports it back except `install.ts` itself,
// which keeps the store reader and the install/stage/uninstall engine.

import { exec } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { isPackageCubeIdentity } from "../package-source.ts"
import type { CubeInstaller } from "./manifest.ts"
import { InstallError } from "./manifest.ts"
import { identitySegments } from "./manifest-validation.ts"

export const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")

export const cubesDir = resolve(join(srcDir, "cubes"))
/** Same override as kernel/scan.ts reads: `qwbe check` points discovery AND the install
 *  destination at one sandbox, so a check never writes into a real plugins directory. */
export const pluginsDir = resolve(process.env.QWBE_PLUGINS_DIR ?? join(srcDir, "..", "plugins"))

/** Package and plugin slugs. Cube identities use `isPackageCubeIdentity` in `checkName`. */
export const NAME = /^[a-z][a-z0-9-]{0,31}$/

/**
 * Guard every path that leaves the installer.
 *
 * `resolve` collapses `..` before the check, so a name that slipped through the pattern still
 * cannot climb out of its root. The trailing separator matters: without it, `/plugins-evil`
 * passes a `startsWith("/plugins")` test.
 */
export const under = (root: string, path: string): string => {
  const full = resolve(path)
  if (full !== root && !full.startsWith(root + sep)) {
    throw new InstallError(`refused: resolved path "${full}" is outside "${root}"`)
  }
  return full
}

export const checkName = (kind: string, name: string): string => {
  if (!(kind === "cube" ? isPackageCubeIdentity(name) : NAME.test(name))) {
    throw new InstallError(`refused: ${kind} name "${name}" is not allowed.`)
  }
  return name
}

export const destinationOf = (pkg: { name: string; kind: "cube" | "plugin" }): string =>
  pkg.kind === "plugin" ? under(pluginsDir, join(pluginsDir, pkg.name)) : under(cubesDir, join(cubesDir, pkg.name))

export const toInstallError = (e: unknown): InstallError =>
  e instanceof InstallError ? e : new InstallError(e instanceof Error ? e.message : String(e))

/**
 * The installer speaks Effect at its face: every refusal travels as `InstallError` in the
 * error channel, while the body stays ordinary strict TypeScript over the filesystem.
 * One `Effect.try` per public method is the whole bridge -- no throw escapes past this line.
 */
export const tried = <A>(run: () => A): Effect.Effect<A, InstallError> =>
  Effect.try({ try: run, catch: toInstallError })

/** Same bridge for the one installer method that awaits an async checker before it stages. */
export const triedPromise = <A>(run: () => Promise<A>): Effect.Effect<A, InstallError> =>
  Effect.tryPromise({ try: run, catch: toInstallError })

export const lifecycleInstaller = (): Pick<CubeInstaller, "cubeOnDisk" | "remove" | "restart"> => ({
  cubeOnDisk: (cube: string, plugin: string | null) => {
    // Discovery predates the package slug grammar and mounts any non-hidden directory. This
    // read capability must describe that state without turning the whole settings catalogue
    // into a 500. Write operations below remain strict and still call checkName.
    if (identitySegments(cube).some((s) => !NAME.test(s)) || (plugin !== null && !NAME.test(plugin))) return false
    const base = plugin ? join(pluginsDir, plugin, "cubes") : cubesDir
    return existsSync(under(base, join(base, ...identitySegments(cube))))
  },

  // Reply first, die second -- the caller must hear "yes" before the port goes away. The delay is
  // what makes that true; without it the response and the exit race, and the loser is the person
  // clicking the button.
  restart: () => {
    setTimeout(() => {
      if ((process.env.QWBE_RESTART_MODE ?? "inband") === "command") {
        const cmd = process.env.QWBE_RESTART_CMD ?? "systemctl --user restart qwbe"
        exec(cmd, (e) => {
          if (e) console.error(`[install] restart command failed: ${e.message}`)
        })
      } else {
        process.exit(0)
      }
    }, 300)
  },

  remove: (cube: string, plugin: string | null) =>
    tried(() => {
      checkName("cube", cube)
      const target = plugin
        ? under(pluginsDir, join(pluginsDir, checkName("plugin", plugin)))
        : under(cubesDir, join(cubesDir, cube))

      if (!existsSync(target)) {
        throw new InstallError(`refused: nothing to remove at "${target.replace(srcDir, "src")}"`)
      }
      rmSync(target, { recursive: true, force: true })
      return { removed: target.replace(resolve(srcDir, ".."), ".") }
    }),
})
