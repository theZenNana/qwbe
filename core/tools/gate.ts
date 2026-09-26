import * as Command from "@effect/platform/Command"
import * as Console from "effect/Console"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { capture } from "./process.ts"
import { exitProblems, gateLine, summaryLine } from "./report.ts"

/** A gate answers with its problems; an empty list is green. */
export interface Gate<R> {
  readonly name: string
  readonly problems: Effect.Effect<ReadonlyArray<string>, never, R>
}

type Argv = readonly [string, ...string[]]

const runCommand = (root: string, argv: Argv) =>
  capture(Command.make(...argv).pipe(Command.workingDirectory(root))).pipe(
    Effect.map(({ status, stdout, stderr }) => exitProblems(argv.join(" "), status, `${stdout}${stderr}`)),
    Effect.catchAll((error) => Effect.succeed([`${argv[0]}: ${error.message}`])),
  )

/** Runs each argv in `root`, one after the other, and gathers their problems. */
export const commands = (root: string, ...argvs: ReadonlyArray<Argv>) =>
  Effect.forEach(argvs, (argv) => runCommand(root, argv)).pipe(Effect.map((lists) => lists.flat()))

/** An in-process gate: every item found is one problem; a failure to look is one problem too. */
export const findings = <A, E, R>(found: Effect.Effect<ReadonlyArray<A>, E, R>, describe: (item: A) => string) =>
  found.pipe(
    Effect.map((items) => items.map(describe)),
    Effect.catchAll((error) => Effect.succeed([String(error)])),
  )

const runGate = <R>(gate: Gate<R>) =>
  Effect.timed(gate.problems).pipe(
    Effect.tap(([elapsed, problems]) => Console.log(gateLine(gate.name, Duration.toMillis(elapsed), problems))),
    Effect.map(([, problems]) => problems.length > 0),
  )

/** Runs every gate without stopping at the first red one; returns the names of the red ones. */
export const runGates = <R>(gates: ReadonlyArray<Gate<R>>) =>
  Effect.forEach(gates, runGate).pipe(
    Effect.map((isRed) => gates.filter((_, index) => isRed[index]).map((gate) => gate.name)),
    Effect.tap((red) => Console.log(summaryLine(red.length, gates.length))),
  )
