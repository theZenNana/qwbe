// The `qwbe` command behind bin/qwbe.mjs: `check` judges a package, `drift` judges a store.
// Prints a report and exits 0 (pass) or 1 (a stage or shelf failed); 2 is a usage or
// environment error, not a verdict.

import { join, resolve } from "node:path"
import { FetchHttpClient, FileSystem, type Runtime } from "@effect/platform"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Cause, Console, Effect, Exit, Layer, Logger } from "effect"
import { type CheckReport, checkPackage } from "./check-package.ts"
import { storeDrift } from "./store-drift.ts"

const usage = `usage: qwbe check <package-dir>
       qwbe drift [store-dir]

check runs the four stages every qwbe package is judged by:
  1. source     the boot-time package contract (the kernel's own checker)
  2. caps       size caps from the installed kernel's qwbe.config.json
  3. runtime    the kernel booted with the package mounted, plus the package's probes/*.mjs
  4. invocation scripts.test is "qwbe check .", the qwbe-core dependency is an install
`

const render = (report: CheckReport): string => {
  const lines: string[] = []
  const r = report.runtime
  if (report.ok && r) {
    lines.push(`  [1/4] source: ok`)
    lines.push(`  [2/4] caps: ok`)
    lines.push(
      `  [3/4] runtime: kernel booted at ${r.url}; ` +
        (r.generic ? `generic probes: ${r.generic.checks} checks, ${r.generic.findings} findings; ` : ``) +
        `probes: ` +
        r.probes.map((p) => `${p.probe} exit ${p.exit}`).join(", "),
    )
    lines.push(`  [4/4] invocation: ok`)
    lines.push(`  qwbe check: PASS`)
  } else {
    lines.push(`  qwbe check: FAIL (stage ${report.failedStage})`)
    for (const f of report.findings) lines.push(`    ${f.rule}: ${f.file} -- ${f.message}`)
  }
  return lines.join("\n")
}

const reason = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

// A malformed kernel config or an unreadable installation is an environment error, not a
// verdict about the package.
const check = (dir: string) =>
  checkPackage(dir).pipe(
    Effect.flatMap((report) => Effect.as(Console.log(render(report)), report.ok ? 0 : 1)),
    Effect.catchAllCause((cause) => Effect.as(Console.error(`qwbe check could not run: ${reason(cause)}`), 2)),
  )

/**
 * Is every shelf in the store provably what its source holds? Default store: the one next to
 * this kernel. 0 every shelf verified; 1 is the red -- drifted, edited or untraceable shelves.
 */
const drift = (storeDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(storeDir))) {
      yield* Console.error(`qwbe drift: no store directory at ${storeDir}`)
      return 2
    }
    const verdicts = yield* storeDrift(storeDir)
    const red = verdicts.filter((v) => v.status !== "ok")
    for (const v of verdicts) {
      if (v.status === "ok") yield* Console.log(`  ok        ${v.name}  staged ${v.stagedAt} from ${v.sourcePath}`)
      else if (v.status === "no-provenance") yield* Console.log(`  RED       ${v.name}  ${v.detail}`)
      else yield* Console.log(`  RED       ${v.name}  staged ${v.stagedAt} from ${v.sourcePath} -- ${v.detail}`)
    }
    yield* Console.log(
      red.length === 0
        ? `  qwbe drift: PASS (${verdicts.length} shelves)`
        : `  qwbe drift: FAIL (${red.length} of ${verdicts.length} shelves are behind, edited or untraceable)`,
    )
    return red.length === 0 ? 0 : 1
  })

const command = (argv: ReadonlyArray<string>) => {
  const [name, dir] = argv
  if (name === "drift" && argv.length <= 2) {
    return drift(dir === undefined ? join(import.meta.dirname, "..", "store") : resolve(dir))
  }
  if (name === "check" && dir !== undefined && argv.length === 2) return check(dir === "." ? process.cwd() : dir)
  return Effect.as(Console.error(usage), 2)
}

// Effect.log* lines (the generic probes' notes) print as plain text, like the report.
const plainLogs = Logger.replace(
  Logger.defaultLogger,
  Logger.withConsoleLog(
    Logger.make(({ message }) => (Array.isArray(message) ? message.map(String).join(" ") : String(message))),
  ),
)

// The exit code, and process.exit even on 0: a handle a cube left open must not keep the command
// alive. An interrupt (Ctrl-C) still closes the scope first: the kernel stops, the database drops.
const teardown: Runtime.Teardown = (exit) => {
  if (Exit.isSuccess(exit)) process.exit(typeof exit.value === "number" ? exit.value : 1)
  process.exit(Cause.isInterruptedOnly(exit.cause) ? 130 : 1)
}

/** Runs `qwbe <argv>` and exits with its code. */
export const main = (argv: ReadonlyArray<string>) =>
  NodeRuntime.runMain(
    command(argv).pipe(Effect.provide(Layer.mergeAll(NodeContext.layer, FetchHttpClient.layer, plainLogs))),
    { disablePrettyLogger: true, teardown },
  )
