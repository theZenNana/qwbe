import * as FileSystem from "@effect/platform/FileSystem"
import * as Effect from "effect/Effect"
import type { CubeDefinition } from "../../src/cube-contract.ts"

type Entry = { readonly name: string; readonly plugin: string | null; readonly definition: CubeDefinition }

/**
 * Points each QWBE_* variable in `names` at its own scoped temp directory, then runs `load`.
 * Kernel modules read those directories at import, so every dynamic kernel `import()` of a check
 * goes inside `load`; the directories are removed when the scope closes.
 */
export const importUnderTempDirs = <const Name extends string, A>(names: ReadonlyArray<Name>, load: () => Promise<A>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dirs = {} as Record<Name, string>
    for (const name of names) {
      dirs[name] = yield* fs.makeTempDirectoryScoped()
      process.env[name] = dirs[name]
    }
    return { dirs, kernel: yield* Effect.promise(load) }
  })

/**
 * The cubes on disk kept by `select`, mounted the way main.ts mounts them but without a database
 * or a port. mount may write switches.json, so QWBE_DATA_DIR is a scoped temp directory.
 */
export const mountCubes = (select: (definitions: ReadonlyArray<Entry>) => ReadonlyArray<Entry>) =>
  Effect.flatMap(
    importUnderTempDirs(["QWBE_DATA_DIR"], () =>
      Promise.all([import("../../src/kernel/discovery.ts"), import("../../src/kernel/space.ts")]),
    ),
    ({ kernel: [{ loadDefinitions, mount, switchesFor }, { loadSpaces }] }) =>
      Effect.gen(function* () {
        const definitions = select(yield* Effect.promise(loadDefinitions))
        const switches = yield* Effect.orDie(switchesFor(definitions))
        return mount(definitions, yield* Effect.promise(loadSpaces), switches)
      }),
  )
