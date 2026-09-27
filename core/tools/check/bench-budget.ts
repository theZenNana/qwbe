// The bench gate of `check --bench`: runs core/checks/bench once through `vitest bench --outputJson`,
// prints every median, and returns each budget from qwbe.yaml the medians break.
import { join } from "node:path"
import * as FileSystem from "@effect/platform/FileSystem"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { readConfig } from "../shared/config.ts"
import { capture, GateFailed } from "../shared/process.ts"
import { BenchReport, mediansOf, overBudget, renderMedians } from "./bench-budget-pure.ts"

// A red run (a server that did not boot, a bench that threw) has no medians worth reading.
const runBenches = (core: string, outputJson: string) =>
  capture(
    ["npx", "vitest", "bench", "--run", "--config", "vitest.bench.config.ts", "--outputJson", outputJson],
    core,
  ).pipe(
    Effect.filterOrFail(
      ({ status }) => status === 0,
      ({ status, stdout, stderr }) =>
        new GateFailed({ message: `vitest bench exited ${status}\n${stdout}${stderr}`, status }),
    ),
  )

const readReport = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(file)).pipe(
    Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(BenchReport))),
  )

// The report file lives in a temp directory removed when the scope closes.
const benchMedians = (core: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const file = join(yield* fs.makeTempDirectoryScoped({ prefix: "qwbe-bench-" }), "bench.json")
      yield* runBenches(core, file)
      return mediansOf(yield* readReport(file))
    }),
  )

/** The budgets are read first, so a broken qwbe.yaml fails before minutes of benchmarks. */
export const benchFindings = (root: string) =>
  Effect.flatMap(readConfig(join(root, "qwbe.yaml")), ({ bench }) =>
    benchMedians(join(root, "core")).pipe(
      Effect.tap((medians) => Console.log(renderMedians(medians))),
      Effect.map((medians) => overBudget(medians, bench)),
    ),
  )
