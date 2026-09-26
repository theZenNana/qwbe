import { basename, join } from "node:path"
import * as FileSystem from "@effect/platform/FileSystem"
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { boot } from "./boot.ts"
import { Workspace, workspace } from "./workspace.ts"

export { ServerDidNotStart, USERS } from "./boot.ts"

/** The real server (core/src/main.ts) on a free port, with its own database and directories. */
export class TestServer extends Context.Tag("TestServer")<
  TestServer,
  {
    readonly base: string
    readonly url: string
    readonly pluginsDir: string
    readonly storeDir: string
    readonly dataDir: string
  }
>() {}

export interface ServerOptions {
  /** Extra environment, e.g. QWBE_MOUNTED or QWBE_ALLOWED_ORIGINS. */
  readonly env?: Readonly<Record<string, string>>
  /** Pack directories copied into the temporary plugins directory before boot. */
  readonly packs?: ReadonlyArray<string>
}

const copyPacks = (packs: ReadonlyArray<string>, pluginsDir: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    Effect.forEach(packs, (pack) => fs.copy(pack, join(pluginsDir, basename(pack))), { discard: true }),
  )

const server = (options: ServerOptions) =>
  Effect.gen(function* () {
    const dirs = yield* Workspace
    yield* copyPacks(options.packs ?? [], dirs.pluginsDir)
    const base = yield* boot(options.env)
    return { base, url: dirs.url, pluginsDir: dirs.pluginsDir, storeDir: dirs.storeDir, dataDir: dirs.dataDir }
  })

/**
 * One booted server per test file: its database, directories and process die with the file.
 * Use it with `layer(testServer(...), { excludeTestServices: true })`: the readiness retry
 * sleeps on the clock, and the default TestClock never advances on its own.
 */
export const testServer = (label: string, options: ServerOptions = {}) =>
  Layer.scoped(TestServer, server(options)).pipe(Layer.provide(workspace(label)), Layer.provideMerge(NodeContext.layer))
