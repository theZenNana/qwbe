import * as Command from "@effect/platform/Command"
import type * as CommandExecutor from "@effect/platform/CommandExecutor"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import { withoutAllowScripts } from "../../tools/process-pure.ts"
import { freePort } from "./free-port.ts"
import { CORE, Workspace } from "./workspace.ts"

export class ServerDidNotStart extends Data.TaggedError("ServerDidNotStart")<{ readonly output: string }> {
  override get message() {
    return `the server did not start; its output:\n${this.output}`
  }
}

export const USERS = { admin: "admin", reader: "reader" } as const

const serverEnv = (port: number, dirs: Workspace["Type"], extra: Readonly<Record<string, string>>) => ({
  ...withoutAllowScripts(process.env),
  QWBE_PORT: String(port),
  QWBE_DATABASE_URL: dirs.url,
  QWBE_DATA_DIR: dirs.dataDir,
  QWBE_PLUGINS_DIR: dirs.pluginsDir,
  QWBE_STORE_DIR: dirs.storeDir,
  QWBE_ADMIN_PASSWORD: USERS.admin,
  QWBE_READER_PASSWORD: USERS.reader,
  ...extra,
})

// Listening means /openapi.json answers: 401 counts, the spec sits behind authentication.
const answering = (base: string) =>
  Effect.tryPromise((signal) => fetch(`${base}/openapi.json`, { signal })).pipe(
    Effect.timeout("2 seconds"),
    Effect.filterOrFail((response) => response.status === 200 || response.status === 401),
    Effect.retry(Schedule.spaced("250 millis")),
    Effect.asVoid,
  )

// stdout and stderr drain for the whole life of the process, so a chatty server never stalls.
const collectOutput = (proc: CommandExecutor.Process) =>
  Effect.gen(function* () {
    const output = yield* Ref.make("")
    yield* Stream.merge(proc.stdout, proc.stderr).pipe(
      Stream.decodeText(),
      Stream.runForEach((text) => Ref.update(output, (all) => all + text)),
      Effect.forkScoped,
    )
    return output
  })

const failWith = (output: Ref.Ref<string>) =>
  Effect.flatMap(Ref.get(output), (text) => Effect.fail(new ServerDidNotStart({ output: text })))

// SIGTERM, then SIGKILL after 5 s: the executor's own release waits for exit without a bound.
const stop = (proc: CommandExecutor.Process) =>
  proc.kill("SIGTERM").pipe(
    Effect.timeout("5 seconds"),
    Effect.catchAll(() => proc.kill("SIGKILL")),
    Effect.ignore,
  )

const ready = (base: string, proc: CommandExecutor.Process, output: Ref.Ref<string>) =>
  Effect.raceFirst(answering(base), Effect.zipRight(Effect.orDie(proc.exitCode), failWith(output))).pipe(
    Effect.timeout("30 seconds"),
    Effect.catchTag("TimeoutException", () => failWith(output)),
  )

/**
 * Boots core/src/main.ts over the workspace on a free port and returns its base URL once it
 * answers. The process lives as long as the calling scope. Needs the real clock
 * (excludeTestServices): the readiness retry sleeps on it.
 */
export const boot = (extra: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const port = yield* freePort
    const base = `http://127.0.0.1:${port}`
    const env = serverEnv(port, yield* Workspace, extra)
    const proc = yield* Command.start(
      Command.make(process.execPath, "src/main.ts").pipe(Command.workingDirectory(CORE), Command.env(env)),
    )
    yield* Effect.addFinalizer(() => stop(proc))
    yield* ready(base, proc, yield* collectOutput(proc))
    return base
  })
