import { inspect } from "node:util"
import * as FileSystem from "@effect/platform/FileSystem"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as ParseResult from "effect/ParseResult"
import * as Schema from "effect/Schema"
import { parse } from "yaml"

export class ConfigInvalid extends Data.TaggedError("ConfigInvalid")<{
  readonly file: string
  readonly message: string
}> {}

export const Port = Schema.Int.pipe(Schema.between(1, 65535))

const Positive = Schema.Number.pipe(Schema.positive())

// Blocking budgets for `check --bench`, held against the benchmark medians by bench-budget.ts.
export const BenchBudgets = Schema.Struct({
  list60k: Schema.Struct({ deepPageFloorMs: Positive, deepPageFactor: Positive, anyAnswerMs: Positive }),
  stagingImport: Schema.Struct({ minRowsPerSecond: Positive }),
})

const Count = Schema.Int.pipe(Schema.positive())

/** p99 in ms at concurrency 1 and 20. */
export const P99Budget = Schema.Struct({ c1: Positive, c20: Positive })

/** How one route is called: path params, query, JSON body (`{n}` in a string becomes the request number), user. */
export const Fixture = Schema.Struct({
  params: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  query: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Union(Schema.String, Schema.Number) })),
  body: Schema.optional(Schema.Unknown),
  user: Schema.optional(Schema.Literal("admin", "reader")),
})

/**
 * A table cloned `rows` times from a row the `create` route's fixture makes: ids `<prefix>-bench1`...,
 * `vary` (a column or a body key) made unique per row.
 */
export const Seed = Schema.Struct({
  table: Schema.String,
  create: Schema.optional(Schema.String),
  prefix: Schema.optional(Schema.String),
  vary: Schema.optional(Schema.String),
  rows: Schema.optional(Count),
})

// The route benchmark of core/tools/api-bench/api-bench.ts, keyed "METHOD /path" as in the OpenAPI spec.
export const ApiBench = Schema.Struct({
  report: Schema.String,
  rows: Count,
  requests: Schema.Struct({ warmup: Count, c1: Count, c20: Count }),
  seeds: Schema.Array(Seed),
  budgets: Schema.Struct({ default: P99Budget, routes: Schema.Record({ key: Schema.String, value: P99Budget }) }),
  exclude: Schema.Record({ key: Schema.String, value: Schema.String }),
  routes: Schema.Record({ key: Schema.String, value: Fixture }),
})

export const QwbeConfig = Schema.Struct({
  version: Schema.Literal(1),
  dev: Schema.Struct({ api: Port, web: Port }),
  // Units allowed to lack tests today; a work queue, ignored by `check --strict`.
  untested: Schema.Array(Schema.String),
  bench: BenchBudgets,
  // Optional: only `npm run bench:api` reads it, and refuses to run without it.
  apiBench: Schema.optional(ApiBench),
})

export type QwbeConfig = typeof QwbeConfig.Type

const strict = { onExcessProperty: "error", errors: "all" } as const

const readText = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(file)).pipe(
    Effect.mapError((error) => new ConfigInvalid({ file, message: `${file}: ${String(error)}` })),
  )

// uniqueKeys: a duplicated key is an error, never a silent last-one-wins.
const parseYaml = (file: string, text: string) =>
  Effect.try({
    try: (): unknown => parse(text, { uniqueKeys: true }),
    catch: (error) => new ConfigInvalid({ file, message: `${file}: invalid YAML; ${String(error)}` }),
  })

export const valueAt = (input: unknown, path: ReadonlyArray<PropertyKey>): unknown =>
  path.reduce<unknown>(
    (value, key) => (typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined),
    input,
  )

const describeIssue = (file: string, input: unknown, issue: ParseResult.ArrayFormatterIssue) =>
  `${file}: ${issue.path.map(String).join(".") || "$"}: ${issue.message}; value ${inspect(valueAt(input, issue.path))}`

const decode = (file: string, input: unknown) =>
  Schema.decodeUnknown(
    QwbeConfig,
    strict,
  )(input).pipe(
    Effect.mapError(
      (error) =>
        new ConfigInvalid({
          file,
          message: ParseResult.ArrayFormatter.formatErrorSync(error)
            .map((issue) => describeIssue(file, input, issue))
            .join("\n"),
        }),
    ),
  )

export const readConfig = (file: string) =>
  readText(file).pipe(
    Effect.flatMap((text) => parseYaml(file, text)),
    Effect.flatMap((input) => decode(file, input)),
  )

export const readUntested = (file: string) => Effect.map(readConfig(file), (config) => config.untested)
