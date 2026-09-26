import type { PlatformError } from "@effect/platform/Error"
import * as FileSystem from "@effect/platform/FileSystem"
import * as Path from "@effect/platform/Path"
import * as Effect from "effect/Effect"

// A missing directory is empty; any other read error is real and fails the caller.
const missing = (error: PlatformError) => error._tag === "SystemError" && error.reason === "NotFound"

/** The visible child directories of `dir`, as full paths; none when `dir` does not exist. */
export const subdirs = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const names = yield* fs.readDirectory(dir).pipe(Effect.catchIf(missing, () => Effect.succeed<string[]>([])))
    const children = names.filter((name) => !name.startsWith(".")).map((name) => path.join(dir, name))
    return yield* Effect.filter(children, (child) =>
      fs.stat(child).pipe(Effect.map((info) => info.type === "Directory")),
    )
  })

/** The directories of `dirs` that exist. */
export const existing = (dirs: ReadonlyArray<string>) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.filter(dirs, (dir) => fs.exists(dir)))
