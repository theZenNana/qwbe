// Entry point: `node core/tools/check.ts [--strict] [--live] [--bench]`. Runs every gate, exit 1 if
// any is red. `--live` adds the checks against real servers, `--bench` the benchmark budgets.
import { fileURLToPath } from "node:url"
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { excused, flagsFrom } from "./args.ts"
import { readUntested } from "./config.ts"
import { gateList } from "./gates.ts"
import { exitCodeFor, runGates } from "./run-gates.ts"
import { gatesAt } from "./steps.ts"

const root = fileURLToPath(new URL("../..", import.meta.url))

Effect.zip(flagsFrom(process.argv.slice(2)), readUntested(`${root}qwbe.yaml`)).pipe(
  Effect.map(([{ strict, live, bench }, untested]) => gatesAt(root, excused(strict, untested), gateList(live, bench))),
  Effect.flatMap(runGates),
  Effect.map(exitCodeFor),
  Effect.catchAll((error) => Effect.as(Console.error(error.message), 1)),
  Effect.tap((code) => Effect.sync(() => (process.exitCode = code))),
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain,
)
