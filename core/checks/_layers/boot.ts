import * as Command from "@effect/platform/Command"
import * as Effect from "effect/Effect"
import { freePort } from "../../src/free-port.ts"
import { collectOutput, startScoped, waitReady } from "../../src/server-process.ts"
import { withoutAllowScripts } from "../../tools/shared/process-pure.ts"
import { CORE, Workspace } from "./workspace.ts"

export { collectOutput, ServerDidNotStart, stop } from "../../src/server-process.ts"

export const USERS = { admin: "admin", reader: "reader" } as const

export const serverEnv = (port: number, dirs: Workspace["Type"], extra: Readonly<Record<string, string>>) => ({
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

/** Starts core/src/main.ts with `env`; the scope stops it on close. */
const spawn = (env: ReturnType<typeof serverEnv>) =>
  startScoped(
    Command.make(process.execPath, "src/main.ts").pipe(
      Command.workingDirectory(CORE),
      Command.env(env, { extendEnv: false }),
    ),
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
    const proc = yield* spawn(serverEnv(port, yield* Workspace, extra))
    yield* waitReady(base, proc, yield* collectOutput(proc))
    return base
  })
