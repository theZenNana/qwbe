import * as Schema from "effect/Schema"

// No argument, or `--strict`; anything else is refused before a gate runs.
const StrictFlag = Schema.transform(
  Schema.Union(Schema.Tuple(), Schema.Tuple(Schema.Literal("--strict"))),
  Schema.Boolean,
  {
    strict: true,
    decode: (args) => args.length === 1,
    encode: (strict) => (strict ? (["--strict"] as const) : ([] as const)),
  },
)

export const strictFrom = Schema.decodeUnknown(StrictFlag)

// Strict excuses nothing: the `untested` list in qwbe.yaml stops counting.
export const excused = (strict: boolean, untested: ReadonlyArray<string>) => (strict ? [] : untested)
