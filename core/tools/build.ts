// Entry point: `node tools/build.ts` (core `build`, which `prepack` runs). tsc into dist/, then the
// SQL migrations tsc does not emit: the kernel applies them at boot from dist/pg/migrations, and
// without the copy the compiled kernel boots into ENOENT.
import { fileURLToPath } from "node:url"
import * as FileSystem from "@effect/platform/FileSystem"
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { inheritOk } from "./process.ts"

const compile = (core: string) => inheritOk(["npx", "tsc", "-p", "tsconfig.build.json"], core)

const copyMigrations = (core: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.copy(`${core}src/pg/migrations`, `${core}dist/pg/migrations`))

const core = fileURLToPath(new URL("..", import.meta.url))

// In order; the first failure stops the rest.
Effect.all([compile(core), copyMigrations(core)], { discard: true }).pipe(
  Effect.tapError((error) => Console.error(`build: ${error.message}`)),
  Effect.isFailure,
  Effect.tap((failed) => Effect.sync(() => (process.exitCode = failed ? 1 : 0))),
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain,
)
