import { join, resolve } from "node:path"
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Effect from "effect/Effect"
import { loadConfig } from "./config.ts"
import { runGates } from "./gate.ts"
import { gateList } from "./gates.ts"

const root = resolve(import.meta.dirname, "../..")
const strict = process.argv.includes("--strict")

// Entry point: load qwbe.yaml, run every gate, turn any red gate into exit code 1.
const main = loadConfig(join(root, "qwbe.yaml")).pipe(
  Effect.map((config) => gateList(root, strict ? [] : config.untested)),
  Effect.flatMap(runGates),
  Effect.tap((red) => Effect.sync(() => (process.exitCode = red.length > 0 ? 1 : 0))),
)

if (process.argv[1] === import.meta.filename) NodeRuntime.runMain(main.pipe(Effect.provide(NodeContext.layer)))
