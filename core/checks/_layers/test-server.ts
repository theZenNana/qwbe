import { basename, join, resolve } from "node:path"
import * as Command from "@effect/platform/Command"
import * as FileSystem from "@effect/platform/FileSystem"
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import { freePort } from "./free-port.ts"
import { TestDb, testDb } from "./test-db.ts"

/** The real server (core/src/main.ts) on a free port, with its own database and directories. */
export class TestServer extends Context.Tag("TestServer")<
  TestServer,
  { readonly base: string; readonly pluginsDir: string; readonly storeDir: string; readonly dataDir: string }
>() {}

export class ServerDidNotStart extends Data.TaggedError("ServerDidNotStart")<{ readonly output: string }> {}

export interface ServerOptions {
  /** Extra environment, e.g. QWBE_MOUNTED or QWBE_ALLOWED_ORIGINS. */
  readonly env?: Readonly<Record<string, string>>
  /** Pack directories copied into the temporary plugins directory before boot. */
  readonly packs?: ReadonlyArray<string>
}

const CORE = resolve(import.meta.dirname, "../..")
export const USERS = { admin: "admin", reader: "reader" } as const

// Listening means /openapi.json answers: 401 counts, the spec sits behind authentication.
const answering = (base: string) =>
  Effect.tryPromise(() => fetch(`${base}/openapi.json`)).pipe(
    Effect.filterOrFail((response) => response.status === 200 || response.status === 401),
    Effect.retry(Schedule.spaced("250 millis").pipe(Schedule.intersect(Schedule.recurs(119)))),
  )

const server = (options: ServerOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { url } = yield* TestDb
    const temp = fs.makeTempDirectoryScoped()
    const [dataDir, pluginsDir, storeDir] = yield* Effect.all([temp, temp, temp])
    for (const pack of options.packs ?? []) yield* fs.copy(pack, join(pluginsDir, basename(pack)))
    const port = yield* freePort
    const base = `http://127.0.0.1:${port}`
    const env = {
      QWBE_PORT: String(port),
      QWBE_DATABASE_URL: url,
      QWBE_DATA_DIR: dataDir,
      QWBE_PLUGINS_DIR: pluginsDir,
      QWBE_STORE_DIR: storeDir,
      QWBE_ADMIN_PASSWORD: USERS.admin,
      QWBE_READER_PASSWORD: USERS.reader,
      ...options.env,
    }
    // The scope kills the process when the test file ends, before its directories and database go.
    const proc = yield* Command.make(process.execPath, "src/main.ts").pipe(
      Command.workingDirectory(CORE),
      Command.env(env),
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
    return { base, pluginsDir, storeDir, dataDir }
  })

/**
 * One booted server per test file: its database, directories and process die with the file.
 * Use it with `it.layer(testServer(...), { excludeTestServices: true })`: the readiness retry
 * sleeps on the clock, and the default TestClock never advances on its own.
 */
export const testServer = (label: string, options: ServerOptions = {}) =>
  Layer.scoped(TestServer, server(options)).pipe(Layer.provide(testDb(label)), Layer.provideMerge(NodeContext.layer))
