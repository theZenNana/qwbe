import * as FileSystem from "@effect/platform/FileSystem"
import * as Effect from "effect/Effect"

/**
 * A scoped temp directory published as `process.env[name]`. Kernel modules read their QWBE_*
 * directories at import, so a check yields this before its first dynamic kernel `import()`.
 */
export const tempDirectoryAs = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    process.env[name] = directory
    return directory
  })
