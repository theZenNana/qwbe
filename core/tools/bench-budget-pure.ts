// Decisions of the bench budget: the names the bench files publish, the report shape
// `vitest bench --outputJson` writes, and each median held to its budget. bench-budget.ts does the I/O.
import * as Schema from "effect/Schema"
import type { BenchBudgets } from "./config.ts"

/** Bench names shared by core/checks/bench and the budget; a rename on one side is a finding. */
export const BENCH = {
  listPrefix: "list-60k",
  listFirst: "list-60k page 1 sorted",
  listDeep: "list-60k page 300 sorted",
  stagingImport: "staging-pg import 100k rows",
} as const

export const STAGING_ROWS = 100_000

// Only what the budget reads; vitest's other fields (p75, p99, rme...) are ignored, not refused.
export const BenchReport = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      groups: Schema.Array(
        Schema.Struct({ benchmarks: Schema.Array(Schema.Struct({ name: Schema.String, median: Schema.Number })) }),
      ),
    }),
  ),
})

type Medians = ReadonlyMap<string, number>

export const mediansOf = (report: typeof BenchReport.Type): Medians =>
  new Map(
    report.files.flatMap((file) =>
      file.groups.flatMap((group) => group.benchmarks.map(({ name, median }) => [name, median] as const)),
    ),
  )

const ms = (value: number) => `${value.toFixed(1)} ms`

const missing = (name: string) => `${name}: no result in the bench report`

const deepPageFindings = (first: number, deep: number, floorMs: number, factor: number) => {
  const limit = Math.max(floorMs, factor * first)
  return deep < limit
    ? []
    : [
        `${BENCH.listDeep}: median ${ms(deep)}, budget under ${ms(limit)} ` +
          `(max of ${floorMs} ms and ${factor} x page 1 at ${ms(first)})`,
      ]
}

// Page 300 costs about what page 1 does: paging runs in SQL, not by skipping rows in the app.
const deepPage = (medians: Medians, floorMs: number, factor: number) => {
  const first = medians.get(BENCH.listFirst)
  const deep = medians.get(BENCH.listDeep)
  if (first === undefined || deep === undefined) {
    return [BENCH.listFirst, BENCH.listDeep].filter((name) => !medians.has(name)).map(missing)
  }
  return deepPageFindings(first, deep, floorMs, factor)
}

const slowAnswers = (medians: Medians, anyAnswerMs: number) =>
  [...medians]
    .filter(([name, median]) => name.startsWith(BENCH.listPrefix) && median >= anyAnswerMs)
    .map(([name, median]) => `${name}: median ${ms(median)}, budget under ${anyAnswerMs} ms`)

const importRate = (median: number | undefined, minRowsPerSecond: number) => {
  if (median === undefined) return [missing(BENCH.stagingImport)]
  const rate = Math.round((STAGING_ROWS * 1000) / median)
  return rate >= minRowsPerSecond
    ? []
    : [
        `${BENCH.stagingImport}: ${rate} rows/s (median ${ms(median)} for ${STAGING_ROWS} rows), ` +
          `budget at least ${minRowsPerSecond} rows/s`,
      ]
}

/** Every budget broken by the medians, one line each; empty when all hold. */
export const overBudget = (medians: Medians, { list60k, stagingImport }: typeof BenchBudgets.Type) => [
  ...deepPage(medians, list60k.deepPageFloorMs, list60k.deepPageFactor),
  ...slowAnswers(medians, list60k.anyAnswerMs),
  ...importRate(medians.get(BENCH.stagingImport), stagingImport.minRowsPerSecond),
]

/** One line per benchmark, printed on a green run too, so the numbers are always seen. */
export const renderMedians = (medians: Medians) =>
  [...medians].map(([name, median]) => `  ${name}: median ${ms(median)}`).join("\n")
