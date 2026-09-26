import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

// Any of `--strict`, `--live`, `--bench`; anything else is refused before a gate runs.
const Flags = Schema.Array(Schema.Literal("--strict", "--live", "--bench"))

export const flagsFrom = (argv: ReadonlyArray<string>) =>
  Effect.map(Schema.decodeUnknown(Flags)(argv), (flags) => ({
    strict: flags.includes("--strict"),
    live: flags.includes("--live"),
    bench: flags.includes("--bench"),
  }))

// Strict excuses nothing: the `untested` list in qwbe.yaml stops counting.
export const excused = (strict: boolean, untested: ReadonlyArray<string>) => (strict ? [] : untested)
