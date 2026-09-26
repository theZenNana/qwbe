import * as NodeContext from "@effect/platform-node/NodeContext"
import { expect, layer } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { CubeDefinition } from "../../src/cube-contract.ts"
import type { CommandRunner, CubeTools } from "../../src/kernel/manifest.ts"
import { tempDirectoryAs } from "./temp-env.ts"

type Entry = { readonly name: string; readonly plugin: string | null; readonly definition: CubeDefinition }

// Reviewed exceptions to "a reader never writes"; a new one fails until it is added here with a reason.
const READER_WRITES = [
  "echo:write", // comments: every write is decided by the entity permission of the target row
  "views:write", // owner decision QWB-62: a reader saves their own views, rows filtered per owner
]

const PROTOTYPE_NAMES = ["toString", "__proto__", "constructor", "hasOwnProperty", "valueOf"]

/** The same cube, with a `create` that hands the dispatcher it receives to `keep` first. */
const capturingCreate = (entry: Entry, keep: (runner: CommandRunner | undefined) => void): Entry => ({
  ...entry,
  definition: {
    ...entry.definition,
    create: (tools: CubeTools) => {
      keep(tools.runCommands)
      return entry.definition.create(tools)
    },
  },
})

const readerWrites = (permissions: ReadonlyMap<string, ReadonlyArray<string>>): ReadonlyArray<string> =>
  [...permissions].filter(([name, roles]) => name.endsWith(":write") && roles.includes("reader")).map(([name]) => name)

// Every cube on disk, mounted without a database. The kernel reads QWBE_DATA_DIR at import and
// mount may write switches.json. The dispatcher never leaves mount except through the `create`
// of the one cube that runs commands (cli), so that `create` is wrapped to keep it.
const mountKernel = Effect.gen(function* () {
  yield* tempDirectoryAs("QWBE_DATA_DIR")
  const { loadDefinitions, mount } = yield* Effect.promise(() => import("../../src/kernel/discovery.ts"))
  const { loadSpaces } = yield* Effect.promise(() => import("../../src/kernel/space.ts"))
  let runner: CommandRunner | undefined
  const keep = (received: CommandRunner | undefined) => {
    runner ??= received
  }
  const definitions = (yield* Effect.promise(loadDefinitions)).map((entry) => capturingCreate(entry, keep))
  const system = mount(definitions, yield* Effect.promise(loadSpaces))
  if (runner === undefined) return yield* Effect.dieMessage("no mounted cube received the command dispatcher")
  return { runner, permissions: system.permissions }
})

class Mounted extends Context.Tag("checks/unit/Mounted")<Mounted, Effect.Effect.Success<typeof mountKernel>>() {}

/** The refusal of `invoke` for a caller holding every permission, so only the dispatcher rule can refuse. */
const refusalOf = (name: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(Mounted, ({ runner, permissions }) => Effect.flip(runner.invoke(name, args, [...permissions.keys()])))

layer(Layer.scoped(Mounted, mountKernel).pipe(Layer.provide(NodeContext.layer)), {
  timeout: 60_000,
  excludeTestServices: true,
})((it) => {
  it.effect("the mounted permissions give reader exactly the reviewed write permissions", () =>
    Effect.map(Mounted, ({ permissions }) => expect([...readerWrites(permissions)].sort()).toEqual(READER_WRITES)),
  )

  it.effect("the dispatcher refuses surplus arguments instead of dropping them", () =>
    Effect.map(refusalOf("notes:count", ["extra", "junk"]), (refusal) =>
      expect(refusal).toEqual({ _tag: "TooManyArgs", allowed: 0, got: 2 }),
    ),
  )

  it.effect("names from Object.prototype and unknown names resolve to no command", () =>
    Effect.map(
      Effect.forEach([...PROTOTYPE_NAMES, "nosuch:command"], (name) => refusalOf(name, [])),
      (refusals) => expect(refusals).toEqual(refusals.map(() => ({ _tag: "UnknownCommand" }))),
    ),
  )
})
