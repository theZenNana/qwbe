import * as Command from "@effect/platform/Command"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import { freePort } from "./free-port.ts"
import { CORE, Workspace } from "./workspace.ts"

export class ServerDidNotStart extends Data.TaggedError("ServerDidNotStart")<{ readonly output: string }> {
  override get message() {
    return `the server did not start; its output:\n${this.output}`
  }
}

export const USERS = { admin: "admin", reader: "reader" } as const

// Listening means /openapi.json answers: 401 counts, the spec sits behind authentication.
const answering = (base: string) =>
  Effect.tryPromise(() => fetch(`${base}/openapi.json`)).pipe(
    Effect.filterOrFail((response) => response.status === 200 || response.status === 401),
    Effect.retry(Schedule.spaced("250 millis").pipe(Schedule.intersect(Schedule.recurs(119)))),
  )

const environment = (port: number, dirs: Workspace["Type"], extra: Readonly<Record<string, string>>) => ({
  QWBE_PORT: String(port),
  QWBE_DATABASE_URL: dirs.url,
  QWBE_DATA_DIR: dirs.dataDir,
  QWBE_PLUGINS_DIR: dirs.pluginsDir,
  QWBE_STORE_DIR: dirs.storeDir,
  QWBE_ADMIN_PASSWORD: USERS.admin,
  QWBE_READER_PASSWORD: USERS.reader,
  ...extra,
})

/**
 * Boots core/src/main.ts over the workspace on a free port and returns its base URL once it
 * answers. The process lives as long as the calling scope: close the scope to stop it, boot again
 * to restart over the same database and directories. Needs the real clock (excludeTestServices).
 */
export const boot = (extra: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const port = yield* freePort
    const base = `http://127.0.0.1:${port}`
    const proc = yield* Command.make(process.execPath, "src/main.ts").pipe(
      Command.workingDirectory(CORE),
      Command.env(environment(port, yield* Workspace, extra)),
      Command.start,
    )
    const output = yield* Ref.make("")
    yield* Stream.merge(proc.stdout, proc.stderr).pipe(
      Stream.decodeText(),
      Stream.runForEach((text) => Ref.update(output, (all) => all + text)),
      Effect.forkScoped,
    )
    const failed = Ref.get(output).pipe(Effect.flatMap((text) => Effect.fail(new ServerDidNotStart({ output: text }))))
    yield* Effect.raceFirst(
      answering(base).pipe(Effect.orElse(() => failed)),
      proc.exitCode.pipe(Effect.orDie, Effect.zipRight(failed)),
    )
    return base
  })
