// core build: tsc into dist/, then the runtime assets tsc does not emit. The kernel applies the
// numbered SQL migrations at boot from dist/pg/migrations; without the copy the compiled kernel
// (the one the tarball installs) boots into ENOENT. Another src-relative asset directory goes here too.
//
//   node tools/build.ts     (core `build`, which `prepack` runs)

import { join, resolve } from "node:path"
import * as Command from "@effect/platform/Command"
import * as FileSystem from "@effect/platform/FileSystem"
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Effect from "effect/Effect"
import { GateFailed, reportFailure } from "./process.ts"

const core = resolve(import.meta.dirname, "..")

// ponytail: shared by db, e2e and setup; lives here because the brief allows new files only.
// Its home is process.ts next to `capture`.
/** Runs `argv` in `cwd` with the terminal attached; a nonzero exit is a GateFailed with that status. */
export const runInherited = (
  cwd: string,
  argv: readonly [string, ...string[]],
  env: Record<string, string | undefined> = {},
) =>
  Command.exitCode(
    Command.make(...argv).pipe(
      Command.workingDirectory(cwd),
      Command.env(env),
      Command.runInShell(process.platform === "win32"),
      Command.stdin("inherit"),
      Command.stdout("inherit"),
      Command.stderr("inherit"),
    ),
  ).pipe(
    Effect.mapError((error) => new GateFailed({ message: `${argv.join(" ")}: ${error.message}`, status: 1 })),
    Effect.filterOrFail(
      (status) => status === 0,
      (status) => new GateFailed({ message: `${argv.join(" ")} exited ${status} in ${cwd}`, status }),
    ),
  )

const copyMigrations = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.copy(join(core, "src/pg/migrations"), join(core, "dist/pg/migrations")),
).pipe(
  Effect.mapError((error) => new GateFailed({ message: `build: cannot ship migrations: ${error.message}`, status: 1 })),
)

const main = runInherited(core, ["npx", "tsc", "-p", "tsconfig.build.json"]).pipe(
  Effect.zipRight(copyMigrations),
  Effect.catchAll(reportFailure),
)

if (process.argv[1] === import.meta.filename) NodeRuntime.runMain(main.pipe(Effect.provide(NodeContext.layer)))
