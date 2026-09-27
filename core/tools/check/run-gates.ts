import * as Console from "effect/Console"
import * as Effect from "effect/Effect"

// A gate passes when it has no findings; a finding is text a person reads to fix it.
export type Gate<R> = {
  readonly name: string
  readonly findings: Effect.Effect<ReadonlyArray<string>, { readonly message: string }, R>
}

export const verdict = (name: string, findings: ReadonlyArray<string>) =>
  `${name}: ${findings.length === 0 ? "PASS" : "FAIL"}`

export const exitCodeFor = (failedGates: number) => (failedGates === 0 ? 0 : 1)

const reportGate = (name: string, findings: ReadonlyArray<string>) =>
  Console.log([verdict(name, findings), ...findings].join("\n"))

const runGate = <R>(gate: Gate<R>) =>
  gate.findings.pipe(
    Effect.catchAll((error) => Effect.succeed([error.message])),
    Effect.tap((findings) => reportGate(gate.name, findings)),
  )

// Runs every gate, never stopping at the first red one, and returns how many failed.
export const runGates = <R>(gates: ReadonlyArray<Gate<R>>) =>
  Effect.map(Effect.forEach(gates, runGate), (results) => results.filter((findings) => findings.length > 0).length)
