// Entry point: `node tools/build.ts` (core `build`, which `prepack` runs). tsc into dist/, then the
// SQL migrations tsc does not emit: the kernel applies them at boot from dist/pg/migrations, and
// without the copy the compiled kernel boots into ENOENT.
import { fileURLToPath } from "node:url"
import * as FileSystem from "@effect/platform/FileSystem"
import * as Effect from "effect/Effect"
import { inheritOk } from "./process.ts"
import { runTool } from "./run-tool.ts"

const compile = (core: string) => inheritOk(["npx", "tsc", "-p", "tsconfig.build.json"], core)

const copyMigrations = (core: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.copy(`${core}src/pg/migrations`, `${core}dist/pg/migrations`))

const core = fileURLToPath(new URL("..", import.meta.url))

// In order; the first failure stops the rest.
runTool(Effect.as(Effect.all([compile(core), copyMigrations(core)]), 0), "build: ")
