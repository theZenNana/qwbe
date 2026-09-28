// The output of the API benchmark: the table and the finding sections on the console, the JSON report
// on disk. A report that cannot be written fails the run, naming the file.
import { dirname } from "node:path"
import * as FileSystem from "@effect/platform/FileSystem"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { ApiBenchFailed } from "./failed.ts"
import { byP99, type Findings, type Result } from "./stats.ts"

const ms = (value: number) => value.toFixed(1)

const HEAD = [
  "route",
  "cube",
  "c1 p50",
  "c1 p99",
  "c1 max",
  "c1 req/s",
  "c20 p50",
  "c20 p99",
  "c20 max",
  "c20 req/s",
  "errors",
  "timeouts",
]

const cells = ({ key, cube, c1, c20 }: Result) => [
  key,
  cube,
  ...[c1, c20].flatMap((stats) => [ms(stats.p50), ms(stats.p99), ms(stats.max), stats.rps.toFixed(0)]),
  String(c1.errors + c20.errors),
  String(c1.timeouts + c20.timeouts),
]

type Row = ReadonlyArray<string>

const columnWidths = (rows: ReadonlyArray<Row>) =>
  HEAD.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)))

// Route and cube to the left, the numbers to the right.
const aligned = (row: Row, widths: ReadonlyArray<number>) =>
  row
    .map((cell, column) => (column < 2 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0)))
    .join("  ")

/** The results as an aligned text table, slowest first; times in ms. */
export const renderTable = (results: ReadonlyArray<Result>) => {
  const rows = [HEAD, ...byP99(results).map(cells)]
  const widths = columnWidths(rows)
  return rows.map((row) => aligned(row, widths)).join("\n")
}

const section = (title: string, lines: ReadonlyArray<string>) =>
  lines.length === 0 ? `${title}: none` : `${title} (${lines.length}):\n${lines.map((line) => `  ${line}`).join("\n")}`

/** The table, then the failures and the over-budget sections. */
export const printResults = (results: ReadonlyArray<Result>, { failures, overBudget }: Findings) =>
  Console.log([renderTable(results), section("failures", failures), section("over budget", overBudget)].join("\n"))

const reportJson = (results: ReadonlyArray<Result>, { failures, overBudget }: Findings, at: Date) =>
  `${JSON.stringify({ at: at.toISOString(), failures, overBudget, results: byP99(results) }, null, 2)}\n`

const writeText = (file: string, text: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    Effect.zipRight(fs.makeDirectory(dirname(file), { recursive: true }), fs.writeFileString(file, text)),
  ).pipe(
    Effect.mapError((error) => new ApiBenchFailed({ message: `cannot write the report ${file}: ${error.message}` })),
  )

/** The results and findings as JSON in `file`, stamped with the time of writing. */
export const writeReport = (file: string, results: ReadonlyArray<Result>, findings: Findings) =>
  writeText(file, reportJson(results, findings, new Date()))
