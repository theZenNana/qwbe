// The installer's leaf internals, split out of `install.ts` for the per-file size cap:
// the path guards and allowed destinations, the package-independent lifecycle methods
// (cubeOnDisk, remove, restart), and the Effect face that keeps `InstallError` on the error
// channel and turns every filesystem error into a defect. Everything here imports from the
// manifest and the package grammar; nothing imports it back except `install.ts` itself,
// which keeps the store reader and the install/stage/uninstall engine.

import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { Command, FileSystem } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { NodeContext } from "@effect/platform-node"
import { Effect } from "effect"
import { readPluginsDir, readRestartCmd, readRestartMode } from "../config.ts"
import { isPackageCubeIdentity } from "../package-source.ts"
import type { CubeInstaller } from "./manifest.ts"
import { InstallError } from "./manifest.ts"
import { identitySegments } from "./manifest-validation.ts"

export const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")

export const cubesDir = resolve(join(srcDir, "cubes"))
/** Same override as kernel/scan.ts reads: `qwbe check` points discovery AND the install
 *  destination at one sandbox, so a check never writes into a real plugins directory. */
export const pluginsDir = resolve(readPluginsDir(join(srcDir, "..", "plugins")))

/** Package and plugin slugs. Cube identities use `isPackageCubeIdentity` in `checkName`. */
export const NAME = /^[a-z][a-z0-9-]{0,31}$/

/**
 * Guard every path that leaves the installer.
 *
 * `resolve` collapses `..` before the check, so a name that slipped through the pattern still
 * cannot climb out of its root. The trailing separator matters: without it, `/plugins-evil`
 * passes a `startsWith("/plugins")` test.
 */
export const under = (root: string, path: string): Effect.Effect<string, InstallError> => {
  const full = resolve(path)
  return full !== root && !full.startsWith(root + sep)
    ? Effect.fail(new InstallError(`refused: resolved path "${full}" is outside "${root}"`))
    : Effect.succeed(full)
}

export const checkName = (kind: string, name: string): Effect.Effect<string, InstallError> =>
  (kind === "cube" ? isPackageCubeIdentity(name) : NAME.test(name))
    ? Effect.succeed(name)
    : Effect.fail(new InstallError(`refused: ${kind} name "${name}" is not allowed.`))

export const destinationOf = (pkg: { name: string; kind: "cube" | "plugin" }) =>
  pkg.kind === "plugin" ? under(pluginsDir, join(pluginsDir, pkg.name)) : under(cubesDir, join(cubesDir, pkg.name))

/** An installer step: a refusal, a filesystem error, and the Node platform it runs on. */
export type InstallStep<A> = Effect.Effect<A, InstallError | PlatformError, NodeContext.NodeContext>

/**
 * The installer speaks Effect at its face: a CONTRACT refusal travels as `InstallError` in
 * the error channel and the router turns it into a 400 carrying the refusal text. A disk error
 * (EACCES, ENOSPC) or a bug is not a package refusal: it becomes a DEFECT, so the router answers
 * 500 without the message -- the operator's log to read, not something the caller should see
 * wrapped as a refusal (QWB-38). The Node platform is provided here, so no requirement leaks
 * into the cube-facing type.
 */
export const face = <A>(effect: InstallStep<A>): Effect.Effect<A, InstallError> =>
  effect.pipe(Effect.catchTags({ SystemError: Effect.die, BadArgument: Effect.die }), Effect.provide(NodeContext.layer))

const runRestartCommand = (cmd: string) =>
  Command.make(cmd).pipe(
    Command.runInShell(true),
    Command.stdout("inherit"),
    Command.stderr("inherit"),
    Command.exitCode,
    Effect.flatMap((code) =>
      code === 0 ? Effect.void : Effect.logError(`[install] restart command failed: exited ${code}`),
    ),
    Effect.catchAll((e) => Effect.logError(`[install] restart command failed: ${e.message}`)),
  )

export const lifecycleInstaller = (): Pick<CubeInstaller, "cubeOnDisk" | "remove" | "restart"> => ({
  cubeOnDisk: (cube: string, plugin: string | null) => {
    // Discovery predates the package slug grammar and mounts any non-hidden directory. This
    // read capability must describe that state without turning the whole settings catalogue
    // into a 500. Write operations below remain strict and still call checkName.
    if (identitySegments(cube).some((s) => !NAME.test(s)) || (plugin !== null && !NAME.test(plugin))) {
      return Effect.succeed(false)
    }
    const base = plugin ? join(pluginsDir, plugin, "cubes") : cubesDir
    return face(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        return yield* fs.exists(yield* under(base, join(base, ...identitySegments(cube))))
      }),
    ).pipe(Effect.orDie)
  },

  // Reply first, die second -- the caller must hear "yes" before the port goes away. The caller
  // forks this after answering; the delay is what makes the answer win the race, and the loser
  // would be the person clicking the button.
  restart: () =>
    Effect.sleep("300 millis").pipe(
      Effect.zipRight(
        Effect.suspend(() =>
          readRestartMode() === "command" ? runRestartCommand(readRestartCmd()) : Effect.sync(() => process.exit(0)),
        ),
      ),
      Effect.provide(NodeContext.layer),
    ),

  remove: (cube: string, plugin: string | null) =>
    face(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* checkName("cube", cube)
        const target = plugin
          ? yield* under(pluginsDir, join(pluginsDir, yield* checkName("plugin", plugin)))
          : yield* under(cubesDir, join(cubesDir, cube))

        if (!(yield* fs.exists(target))) {
          return yield* new InstallError(`refused: nothing to remove at "${target.replace(srcDir, "src")}"`)
        }
        yield* fs.remove(target, { recursive: true })
        return { removed: target.replace(resolve(srcDir, ".."), ".") }
      }),
    ),
})
