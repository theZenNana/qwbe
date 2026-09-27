import { join } from "node:path"
import * as Command from "@effect/platform/Command"
import type * as CommandExecutor from "@effect/platform/CommandExecutor"
import * as FileSystem from "@effect/platform/FileSystem"
import { expect, it } from "@effect/vitest"
import * as Console from "effect/Console"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Schedule from "effect/Schedule"
import { collectOutput, serverEnv, stop } from "../_layers/boot.ts"
import { freePort } from "../_layers/free-port.ts"
import { sessionAs } from "../_layers/session.ts"
import { testWorkspace } from "../_layers/test-server.ts"
import { CORE, Workspace } from "../_layers/workspace.ts"

// Replaces probes/admin-restart.mjs: the admin restart button under core/tools/dev/dev.ts, the dev
// supervisor. The API exits 0, the supervisor brings it back, the web frontend stays up.
// Opt-in, slow (Next compiles in dev mode): QWBE_CHECK_RESTART=1 npm --prefix core run test:live.

const OPT_IN = process.env.QWBE_CHECK_RESTART === "1"
const ROOT = join(CORE, "..")
const WEB = join(ROOT, "web")

// Next dev with its own distDir rewrites these; they are put back as they were.
const GENERATED = ["next-env.d.ts", "tsconfig.json", "AGENTS.md", "CLAUDE.md"].map((name) => join(WEB, name))

const local = (port: number) => `http://127.0.0.1:${port}`

// Listening means an answer: 401 counts, the API spec sits behind authentication.
const answers = (url: string) =>
  Effect.tryPromise((signal) => fetch(url, { signal })).pipe(
    Effect.timeout("2 seconds"),
    Effect.map((response) => response.ok || response.status === 401),
    Effect.orElseSucceed(() => false),
  )

const until = (check: Effect.Effect<boolean>, within: Duration.DurationInput, what: string) =>
  check.pipe(
    Effect.repeat({ schedule: Schedule.spaced("250 millis"), until: (ok) => ok }),
    Effect.timeoutFail({
      duration: within,
      onTimeout: () => new Error(`${what}: not within ${Duration.format(within)}`),
    }),
  )

const restore = (path: string, saved: Option.Option<Uint8Array>) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    Option.match(saved, {
      onNone: () => fs.remove(path, { force: true }),
      onSome: (bytes) => fs.writeFile(path, bytes),
    }),
  )

/** Snapshots `paths` now and writes them back (or removes the new ones) when the scope closes. */
const preserved = (paths: ReadonlyArray<string>) =>
  Effect.acquireRelease(
    Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.forEach(paths, (path) => Effect.option(fs.readFile(path)))),
    (saved) =>
      Effect.forEach(paths, (path, i) => restore(path, saved[i] ?? Option.none()), { discard: true }).pipe(
        Effect.ignore,
      ),
  )

const removedOnClose = (dir: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    Effect.addFinalizer(() => fs.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore)),
  )

/** The web tree as it was before the run: generated files restored, the check's distDir removed. */
const guardWebTree = (distDir: string) => Effect.zipRight(preserved(GENERATED), removedOnClose(join(WEB, distDir)))

// Registered after the snapshot, so its SIGTERM runs first and Next is gone before the restore.
const startDev = (env: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function* () {
    const proc = yield* Command.start(
      Command.make(process.execPath, join(CORE, "tools", "dev", "dev.ts"), "start").pipe(
        Command.workingDirectory(ROOT),
        Command.env(env, { extendEnv: false }),
      ),
    )
    yield* Effect.addFinalizer(() => stop(proc, "15 seconds"))
    return proc
  })

const bothStarted = (api: string, web: string) =>
  Effect.zipRight(
    until(answers(`${api}/openapi.json`), "60 seconds", "the API starts"),
    until(answers(web), "120 seconds", "the web frontend starts"),
  )

const requestRestart = (api: string) =>
  Effect.gen(function* () {
    const admin = yield* sessionAs(api, "admin")
    expect((yield* admin.send("POST", "/settings/restart")).status).toBe(200)
  })

/** The API goes down and comes back; the supervisor and the web frontend never do. */
const watchRecovery = (api: string, web: string, proc: CommandExecutor.Process) =>
  Effect.gen(function* () {
    yield* until(
      Effect.map(answers(`${api}/openapi.json`), (up) => !up),
      "10 seconds",
      "the API exits",
    )
    const [recovery] = yield* Effect.timed(until(answers(`${api}/openapi.json`), "30 seconds", "the API comes back"))
    yield* Console.log(`admin-restart: API back in ${Math.round(Duration.toMillis(recovery))} ms`)
    expect([yield* proc.isRunning, yield* answers(web)]).toEqual([true, true])
  })

const printTail = (output: Ref.Ref<string>) =>
  Effect.flatMap(Ref.get(output), (text) => Console.error(text.slice(-2000)))

const program = Effect.gen(function* () {
  const [apiPort, webPort] = [yield* freePort, yield* freePort]
  const distDir = `.next-check-${webPort}`
  yield* guardWebTree(distDir)
  const env = serverEnv(apiPort, yield* Workspace, { QWBE_WEB_PORT: String(webPort), QWBE_WEB_DIST_DIR: distDir })
  const proc = yield* startDev(env)
  const output = yield* collectOutput(proc)
  const [api, web] = [local(apiPort), local(webPort)]
  yield* bothStarted(api, web).pipe(
    Effect.zipRight(requestRestart(api)),
    Effect.zipRight(watchRecovery(api, web, proc)),
    Effect.tapError(() => printTail(output)),
  )
})

it.live.skipIf(!OPT_IN)(
  "the API comes back after the admin restart and the web frontend stays up",
  () => Effect.scoped(program).pipe(Effect.provide(testWorkspace("admin-restart"))),
  240_000,
)
