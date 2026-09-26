// Entry point: `node core/tools/check.ts [--strict] [--live] [--bench]`. Runs every gate, exit 1 if
// any is red. `--live` adds the checks against real servers, `--bench` the benchmark budgets.
import { fileURLToPath } from "node:url"
import * as Effect from "effect/Effect"
import { excused, flagsFrom } from "./args.ts"
import { readUntested } from "./config.ts"
import { gatesFor } from "./gates.ts"
import { exitCodeFor, runGates } from "./run-gates.ts"
import { runTool } from "./run-tool.ts"

const root = fileURLToPath(new URL("../..", import.meta.url))

const gates = Effect.zipWith(
  flagsFrom(process.argv.slice(2)),
  readUntested(`${root}qwbe.yaml`),
  ({ strict, live, bench }, untested) => gatesFor(root, excused(strict, untested), live, bench),
)

runTool(gates.pipe(Effect.flatMap(runGates), Effect.map(exitCodeFor)))
