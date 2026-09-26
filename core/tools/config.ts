import * as FileSystem from "@effect/platform/FileSystem"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as ParseResult from "effect/ParseResult"
import * as Schema from "effect/Schema"
import { parse } from "yaml"
import { describeIssues } from "./schema-issues.ts"

export class ConfigInvalid extends Data.TaggedError("ConfigInvalid")<{
  readonly file: string
  readonly message: string
}> {}

const port = Schema.Int.pipe(Schema.between(1, 65535))
export const Config = Schema.Struct({
  version: Schema.Literal(1),
  dev: Schema.Struct({ api: port, web: port }),
  untested: Schema.Array(Schema.NonEmptyString),
  // Budgets for `check --bench`, set from the median of reference runs.
  bench: Schema.Struct({
    list60k: Schema.Struct({
      deepPageFloorMs: Schema.Positive,
      deepPageFactor: Schema.Positive,
      anyAnswerMs: Schema.Positive,
    }),
    stagingImport: Schema.Struct({ minRowsPerSecond: Schema.Positive }),
  }),
})

/** A duplicate key, an unknown key or a wrong value in `text` is a ConfigInvalid naming `file`. */
const decodeConfig = (file: string, text: string) =>
  Effect.gen(function* () {
    const input = yield* Effect.try({
      try: (): unknown => parse(text, { uniqueKeys: true }),
      catch: (error) => new ConfigInvalid({ file, message: `${file}: $: ${String(error)}` }),
    })
    return yield* Schema.decodeUnknown(Config, { onExcessProperty: "error", errors: "all" })(input).pipe(
      Effect.mapError((error) => {
        const issues = ParseResult.ArrayFormatter.formatErrorSync(error)
        return new ConfigInvalid({ file, message: describeIssues(file, input, issues) })
      }),
    )
  })

export const loadConfig = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs
      .readFileString(file)
      .pipe(Effect.mapError((error) => new ConfigInvalid({ file, message: `${file}: ${error.message}` })))
    return yield* decodeConfig(file, text)
  })
