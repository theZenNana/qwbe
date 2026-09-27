import * as NodeContext from "@effect/platform-node/NodeContext"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"

// The last line of every entry point: the program's number becomes the exit code; a failure prints
// its message after `label` and exits 1.
export const runTool = <E extends { readonly message: string }>(
  program: Effect.Effect<number, E, NodeContext.NodeContext>,
  label = "",
) =>
  program.pipe(
    Effect.catchAll((error) => Effect.as(Console.error(`${label}${error.message}`), 1)),
    Effect.tap((code) => Effect.sync(() => (process.exitCode = code))),
    Effect.provide(NodeContext.layer),
    NodeRuntime.runMain,
  )
