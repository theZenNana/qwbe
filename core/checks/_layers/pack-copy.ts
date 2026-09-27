import { basename, join } from "node:path"
import * as FileSystem from "@effect/platform/FileSystem"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import { MANIFEST, PKG, PKG_CUBE, renameBookmarks } from "./pack-rename.ts"
import { CORE } from "./workspace.ts"

export { PKG, PKG_CUBE } from "./pack-rename.ts"

export class RenameMissed extends Data.TaggedError("RenameMissed")<{ readonly file: string }> {
  override get message() {
    return `${this.file} no longer names its cube "bookmarks"; the rename in pack-rename.ts is stale`
  }
}

const BOOKMARKS = join(CORE, "plugins", "example-plugin", "cubes", "booktags", "bookmarks")

/** Pure: the renamed source, or RenameMissed when the rename no longer matches anything. */
const renamedIndex = (file: string, source: string) => {
  const renamed = renameBookmarks(source)
  return renamed === source ? Effect.fail(new RenameMissed({ file })) : Effect.succeed(renamed)
}

const rewriteIndex = (fs: FileSystem.FileSystem, file: string) =>
  fs.readFileString(file).pipe(
    Effect.flatMap((source) => renamedIndex(file, source)),
    Effect.flatMap((renamed) => fs.writeFileString(file, renamed)),
  )

/** A `Plant` that copies the pack directory `pack` unchanged into `dir` under its own name. */
export const copyPack = (pack: string) => (dir: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.copy(pack, join(dir, basename(pack))))

/**
 * Writes package PKG (a renamed copy of the example bookmarks cube) into `dir`: a store to
 * install it from, or a plugins directory to mount it directly. It resolves `qwbe-core` only once
 * mounted under core/plugins, which the workspace plugins directory is.
 */
export const plantBookmarksCopy = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const cubeDir = join(dir, PKG, "cubes", PKG_CUBE)
    yield* fs.copy(BOOKMARKS, cubeDir)
    yield* rewriteIndex(fs, join(cubeDir, "index.ts"))
    yield* fs.writeFileString(join(dir, PKG, "qwbe-package.json"), JSON.stringify(MANIFEST))
  })
