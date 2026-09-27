import * as NodeContext from "@effect/platform-node/NodeContext"
import { expect, layer } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { CubeDefinition } from "../../src/cube-contract.ts"
import type { CommandRunner } from "../../src/kernel/manifest.ts"
import { mountCubes } from "./temp-env.ts"

// Reviewed exceptions to "a reader never writes"; a new one fails until it is added here with a reason.
const READER_WRITES = [
  "echo:write", // comments: every write is decided by the entity permission of the target row
  "views:write", // owner decision QWB-62: a reader saves their own views, rows filtered per owner
]

const PROTOTYPE_NAMES = ["toString", "__proto__", "constructor", "hasOwnProperty", "valueOf"]

/** The same `create`, handing the dispatcher it receives to `keep` first. */
const capturingCreate =
  (create: CubeDefinition["create"], keep: (runner: CommandRunner | undefined) => void): CubeDefinition["create"] =>
  (tools) => {
    keep(tools.runCommands)
    return create(tools)
  }

const readerWrites = (permissions: ReadonlyMap<string, ReadonlyArray<string>>): ReadonlyArray<string> =>
  [...permissions].filter(([name, roles]) => name.endsWith(":write") && roles.includes("reader")).map(([name]) => name)

// Every cube on disk. The dispatcher never leaves mount except through the `create` of the one
// cube that runs commands (cli), so every `create` is wrapped to keep the first one it receives.
const mountKernel = Effect.gen(function* () {
  const received: Array<CommandRunner> = []
  const keep = (runner: CommandRunner | undefined) => runner && received.push(runner)
  const system = yield* mountCubes((definitions) =>
    definitions.map((entry) => ({
      ...entry,
      definition: { ...entry.definition, create: capturingCreate(entry.definition.create, keep) },
    })),
  )
  const [runner] = received
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
