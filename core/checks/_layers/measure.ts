import { join, resolve } from "node:path"
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { loadConfig } from "../../tools/config.ts"

/** Pure: the median of `values` (the mean of the two middle ones for an even count). */
export const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

/** One benchmark line, straight to stdout so the test runner cannot swallow it. */
export const benchLine = (text: string) => Effect.sync(() => process.stdout.write(`bench ${text}\n`))

/** Runs `effect` `runs` times, prints one bench line, and returns the median in milliseconds. */
export const medianMs = <A, E, R>(title: string, effect: Effect.Effect<A, E, R>, runs = 5) =>
  Effect.forEach(Array.from({ length: runs }), () => Effect.timed(effect)).pipe(
    Effect.map((results) => median(results.map(([elapsed]) => Duration.toMillis(elapsed)))),
    Effect.tap((ms) => benchLine(`${title}: median ${ms.toFixed(1)} ms over ${runs} runs`)),
  )

/** The `bench` budgets from qwbe.yaml at the repository root. */
export const budgets = loadConfig(join(resolve(import.meta.dirname, "../../.."), "qwbe.yaml")).pipe(
  Effect.map((config) => config.bench),
  Effect.provide(NodeContext.layer),
  Effect.orDie,
)
