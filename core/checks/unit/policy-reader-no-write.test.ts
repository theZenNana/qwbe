import * as FileSystem from "@effect/platform/FileSystem"
import * as NodeContext from "@effect/platform-node/NodeContext"
import { expect, layer } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { CommandRunner, CubeTools } from "../../src/kernel/manifest.ts"

// Every cube discovered on disk, mounted without a database. The kernel reads QWBE_DATA_DIR at
// import and mount may write switches.json, so the data directory is a scoped temp directory.
// The dispatcher never leaves mount; the one cube that runs commands (cli) receives it in
// `create`, so a spy around that `create` hands it to the check.
const mounted = Effect.gen(function* () {
  process.env.QWBE_DATA_DIR = yield* FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.makeTempDirectoryScoped()))
  const { loadDefinitions, mount } = yield* Effect.promise(() => import("../../src/kernel/discovery.ts"))
  const { loadSpaces } = yield* Effect.promise(() => import("../../src/kernel/space.ts"))
  const definitions = yield* Effect.promise(loadDefinitions)
  let runner: CommandRunner | undefined
  const spied = definitions.map((entry) => {
    if (!entry.definition.manifest.runsCommands) return entry
    const create = entry.definition.create
    const spy = (tools: CubeTools) => {
      runner = tools.runCommands
      return create(tools)
    }
    return { ...entry, definition: { ...entry.definition, create: spy } }
  })
  const system = mount(spied as typeof definitions, yield* Effect.promise(loadSpaces))
  if (!runner) return yield* Effect.dieMessage("no mounted cube received the command dispatcher")
  return { definitions, runner, everyPermission: [...system.permissions.keys()] }
})

class Mounted extends Context.Tag("Mounted")<Mounted, Effect.Effect.Success<typeof mounted>>() {}

const PROTOTYPE_NAMES = ["toString", "__proto__", "constructor", "hasOwnProperty", "valueOf"]

// Reviewed exceptions to "a reader never writes"; a new one fails until it is added here with a reason.
const READER_WRITES = [
  "echo:write", // comments: every write is decided by the entity permission of the target row
  "views:write", // owner decision QWB-62: a reader saves their own views, rows filtered per owner
] as const

layer(Layer.scoped(Mounted, mounted).pipe(Layer.provide(NodeContext.layer)), {
  timeout: 60_000,
  excludeTestServices: true,
})((it) => {
  it.effect("no manifest grants a write permission to reader beyond the reviewed ones", () =>
    Effect.gen(function* () {
      const granted = (yield* Mounted).definitions
        .flatMap(({ definition }) => definition.manifest.permissions ?? [])
        .filter((p) => p.name.endsWith(":write") && p.roles.includes("reader"))
      expect(granted.map((p) => p.name).sort()).toEqual([...READER_WRITES].sort())
    }),
  )

  it.effect("the dispatcher refuses surplus arguments instead of dropping them", () =>
    Effect.gen(function* () {
      const { runner, everyPermission } = yield* Mounted
      const error = yield* Effect.flip(runner.invoke("notes:count", ["extra", "junk"], everyPermission))
      expect(error).toEqual({ _tag: "TooManyArgs", allowed: 0, got: 2 })
    }),
  )

  it.effect("a name from Object.prototype does not resolve to a command", () =>
    Effect.gen(function* () {
      const { runner, everyPermission } = yield* Mounted
      for (const name of PROTOTYPE_NAMES) {
        expect(yield* Effect.flip(runner.invoke(name, [], everyPermission))).toEqual({ _tag: "UnknownCommand" })
      }
    }),
  )
})
