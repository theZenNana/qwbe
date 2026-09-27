import * as FileSystem from "@effect/platform/FileSystem"
import * as Effect from "effect/Effect"
import { QwbeConfig } from "../../src/config.ts"
import type { CubeDefinition } from "../../src/cube-contract.ts"
import { loadDefinitions, mount, switchesFor } from "../../src/kernel/discovery.ts"
import { loadSpaces } from "../../src/kernel/space.ts"
import { testConfig } from "../../src/test-config.ts"

type Entry = { readonly name: string; readonly plugin: string | null; readonly definition: CubeDefinition }

/**
 * The cubes on disk kept by `select`, mounted the way main.ts mounts them but without a database
 * or a port. mount may write switches.json, so the config's data directory is a scoped temp one.
 */
export const mountCubes = (select: (definitions: ReadonlyArray<Entry>) => ReadonlyArray<Entry>) =>
  Effect.gen(function* () {
    const dataDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
    return yield* Effect.gen(function* () {
      const definitions = select(yield* Effect.orDie(loadDefinitions))
      const switches = yield* Effect.orDie(switchesFor(definitions))
      return yield* Effect.orDie(mount(definitions, yield* Effect.orDie(loadSpaces), switches))
    }).pipe(Effect.provideService(QwbeConfig, testConfig({ QWBE_DATA_DIR: dataDir })))
  })
