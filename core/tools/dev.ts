// The API and the web app side by side, every line prefixed with who said it.
//
//   node core/tools/dev.ts [start|api|web]      start (default) runs both
//
// Exit 0 of the API restarts it: the admin restart relies on that. Any other exit, of either
// child, stops the rest. Ctrl-C closes the scope, which SIGTERMs each child's process group
// (npm runs Next as a grandchild; the group takes both down).

import { join, resolve } from "node:path"
import * as Command from "@effect/platform/Command"
import type { CommandExecutor } from "@effect/platform/CommandExecutor"
import type { PlatformError } from "@effect/platform/Error"
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Console from "effect/Console"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { type DevPorts, ensureFree, loadDevPorts } from "./dev-ports.ts"
import { GateFailed, reportFailure } from "./process.ts"

const root = resolve(import.meta.dirname, "../..")
const QUICK_EXIT_MS = 10_000
const MAX_QUICK_EXITS = 5

export type AfterExit =
  | { readonly _tag: "Restart"; readonly delay: number; readonly quickExits: number }
  | { readonly _tag: "Stop"; readonly status: number; readonly reason: string }

/** Restart on exit 0 with backoff; more than five clean exits in a row, each under 10 s, is a loop and stops. */
export const afterExit = (code: number, ranMillis: number, quickExits: number): AfterExit => {
  if (code !== 0) return { _tag: "Stop", status: code, reason: `exited (code ${code}), stopping the rest` }
  const quick = ranMillis < QUICK_EXIT_MS ? quickExits + 1 : 1
  if (quick > MAX_QUICK_EXITS)
    return { _tag: "Stop", status: 1, reason: `exited cleanly ${quick} times in under 10s, stopping the restart loop` }
  return { _tag: "Restart", delay: Math.min(250 * 2 ** (quick - 1), 4000), quickExits: quick }
}

/** The services a subcommand starts; undefined for an unknown one. */
export const servicesOf = (subcommand = "start") =>
  subcommand === "start"
    ? (["api", "web"] as const)
    : subcommand === "api" || subcommand === "web"
      ? ([subcommand] as const)
      : undefined

/** `[name] line`, the tag in an ANSI color when the output is a terminal. */
export const prefixer = (name: string, color: number, tty: boolean) => {
  const tag = tty ? `\x1b[${color}m[${name}]\x1b[0m` : `[${name}]`
  return (line: string) => `${tag} ${line}`
}

type Prefix = (line: string) => string

const echo = (prefix: Prefix, output: Stream.Stream<Uint8Array, PlatformError>) =>
  output.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => Console.log(prefix(line))),
  )

/** One run of `command` with its output echoed; its exit code, 1 when a signal ended it. */
const runOnce = (command: Command.Command, prefix: Prefix) =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* Command.start(command)
      const [code] = yield* Effect.all([child.exitCode, echo(prefix, child.stdout), echo(prefix, child.stderr)], {
        concurrency: "unbounded",
      })
      return code
    }),
  ).pipe(Effect.catchAll((error) => Console.log(prefix(error.message)).pipe(Effect.as(1))))

const once = (command: Command.Command, prefix: Prefix) =>
  runOnce(command, prefix).pipe(Effect.tap((code) => Console.log(prefix(`exited (code ${code}), stopping the rest`))))

const supervise = (
  command: Command.Command,
  prefix: Prefix,
  quickExits = 0,
): Effect.Effect<number, never, CommandExecutor> =>
  Effect.timed(runOnce(command, prefix)).pipe(
    Effect.flatMap(([ran, code]) => {
      const next = afterExit(code, Duration.toMillis(ran), quickExits)
      if (next._tag === "Stop") return Console.log(prefix(next.reason)).pipe(Effect.as(next.status))
      return Console.log(prefix(`exited (code 0); restarting in ${next.delay}ms`)).pipe(
        Effect.zipRight(Effect.sleep(next.delay)),
        Effect.zipRight(supervise(command, prefix, next.quickExits)),
      )
    }),
  )

const services = (ports: DevPorts) => {
  const tty = process.stdout.isTTY === true
  const api = Command.make(process.execPath, "src/main.ts").pipe(
    Command.workingDirectory(join(root, "core")),
    Command.env({ QWBE_PORT: String(ports.api) }),
  )
  const web = Command.make("npm", "run", "dev", "--", "-p", String(ports.web)).pipe(
    Command.workingDirectory(join(root, "web")),
    // The frontend knows the API only by its address; a moved QWBE_PORT has to reach it.
    Command.env({ NEXT_PUBLIC_QWBE_API: process.env.NEXT_PUBLIC_QWBE_API ?? `http://127.0.0.1:${ports.api}` }),
    Command.runInShell(process.platform === "win32"),
  )
  return {
    api: { port: ports.api, run: supervise(api, prefixer("api", 36, tty)) },
    web: { port: ports.web, run: once(web, prefixer("web", 35, tty)) },
  }
}

const main = Effect.gen(function* () {
  const names = servicesOf(process.argv[2])
  if (names === undefined)
    return yield* new GateFailed({ message: "usage: node core/tools/dev.ts [start|api|web]", status: 2 })
  const all = services(yield* loadDevPorts(join(root, "qwbe.yaml")))
  const chosen = names.map((name) => ({ name, ...all[name] }))
  yield* Effect.forEach(chosen, ({ name, port }) => ensureFree(name, port))
  yield* Console.log(chosen.map(({ name, port }) => `${name} on http://127.0.0.1:${port}`).join(", "))
  // Admin password: QWBE_ADMIN_PASSWORD, or printed once by the API at first seed (README, First account).
  yield* Console.log("Sign in as admin. Ctrl-C stops everything.\n")
  const status = yield* Effect.raceAll(chosen.map(({ run }) => run))
  process.exitCode = status
}).pipe(
  Effect.catchTags({
    GateFailed: reportFailure,
    PortTaken: (error) => reportFailure(new GateFailed({ message: error.message, status: 1 })),
    ConfigInvalid: (error) => reportFailure(new GateFailed({ message: error.message, status: 1 })),
  }),
)

if (process.argv[1] === import.meta.filename) NodeRuntime.runMain(main.pipe(Effect.provide(NodeContext.layer)))
