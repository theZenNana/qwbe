import * as Command from "@effect/platform/Command"
import * as Console from "effect/Console"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { capture } from "./process.ts"

/** A gate answers with its problems; an empty list is green. */
export interface Gate<R> {
  readonly name: string
  readonly problems: Effect.Effect<ReadonlyArray<string>, never, R>
}

/** Runs each argv in `root`; a nonzero exit is a problem, with the last lines of its output. */
export const commands = (root: string, ...argvs: ReadonlyArray<readonly [string, ...string[]]>) =>
  Effect.forEach(argvs, ([bin, ...args]) =>
    capture(Command.make(bin, ...args).pipe(Command.workingDirectory(root))).pipe(
      Effect.map(({ status, stdout, stderr }) =>
        status === 0
          ? []
          : [`${[bin, ...args].join(" ")} exited ${status}`, ...`${stdout}${stderr}`.trimEnd().split("\n").slice(-15)],
      ),
      Effect.catchAll((error) => Effect.succeed([`${bin}: ${error.message}`])),
    ),
  ).pipe(Effect.map((lists) => lists.flat()))

/** An in-process gate: every item found is one problem; a failure to look is one problem too. */
export const findings = <A, E, R>(found: Effect.Effect<ReadonlyArray<A>, E, R>, describe: (item: A) => string) =>
  found.pipe(
    Effect.map((items) => items.map(describe)),
    Effect.catchAll((error) => Effect.succeed([String(error)])),
  )

const reportGate = (name: string, elapsed: Duration.Duration, problems: ReadonlyArray<string>) =>
  Console.log(
    [
      `${problems.length === 0 ? "PASS" : "FAIL"} ${name} (${Math.round(Duration.toMillis(elapsed))} ms)`,
      ...problems.map((line) => `  ${line}`),
    ].join("\n"),
  )

/** Runs every gate without stopping at the first red one; returns the names of the red ones. */
export const runGates = <R>(gates: ReadonlyArray<Gate<R>>) =>
  Effect.gen(function* () {
    const red: string[] = []
    for (const gate of gates) {
      const [elapsed, problems] = yield* Effect.timed(gate.problems)
      yield* reportGate(gate.name, elapsed, problems)
      if (problems.length > 0) red.push(gate.name)
    }
    yield* Console.log(`\n${gates.length - red.length}/${gates.length} gates green`)
    return red
  })
