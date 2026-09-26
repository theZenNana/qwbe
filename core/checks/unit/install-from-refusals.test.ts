import { join } from "node:path"
import * as Command from "@effect/platform/Command"
import type * as CommandExecutor from "@effect/platform/CommandExecutor"
import * as FileSystem from "@effect/platform/FileSystem"
import * as NodeContext from "@effect/platform-node/NodeContext"
import { expect, layer } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { PROVENANCE, packageSourceFingerprint } from "../../src/package-source.ts"

// install.ts and install-parts.ts read QWBE_STORE_DIR and QWBE_PLUGINS_DIR at import, so both
// point at scoped temp directories before the installer loads. Sources live in a third one.
const bench = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const [store, plugins, sources] = yield* Effect.all([1, 2, 3].map(() => fs.makeTempDirectoryScoped()))
  process.env.QWBE_STORE_DIR = store
  process.env.QWBE_PLUGINS_DIR = plugins
  const { installerFor } = yield* Effect.promise(() => import("../../src/kernel/install.ts"))
  return { installer: installerFor(async () => []), store: store!, plugins: plugins!, sources: sources! }
})

class Bench extends Context.Tag("Bench")<Bench, Effect.Effect.Success<typeof bench>>() {}

/** Creates `sources/<name>` holding `files` (relative path to text) and returns its path. */
const plant = (name: string, files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = join((yield* Bench).sources, name)
    for (const [path, text] of Object.entries(files)) {
      yield* fs.makeDirectory(join(dir, path, ".."), { recursive: true })
      yield* fs.writeFileString(join(dir, path), text)
    }
    return dir
  })

const manifest = (fields: object) => JSON.stringify({ kind: "cube", ...fields })
const cube = (name: string) => plant(name, { "qwbe-package.json": manifest({ name }), "index.ts": "// cube\n" })
const symlink = (target: string, link: string) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.symlink(target, link)))

const linkRoot = Effect.gen(function* () {
  const link = join((yield* Bench).sources, "linkroot")
  yield* symlink(yield* cube("linktarget"), link)
  return link
})
// The link points out of the source root, at the sources directory itself.
const linkInside = Effect.gen(function* () {
  const dir = yield* cube("escapeplugin")
  yield* symlink((yield* Bench).sources, join(dir, "sneaky"))
  return dir
})
const fifoInside = Effect.gen(function* () {
  const dir = yield* cube("fifoplugin")
  expect(yield* Command.exitCode(Command.make("mkfifo", join(dir, "pipe")))).toBe(0)
  return dir
})
const plugin = (name: string, cubes: ReadonlyArray<string>, files: Readonly<Record<string, string>> = {}) =>
  plant(name, { "qwbe-package.json": manifest({ name, kind: "plugin", cubes }), ...files })

type Source = Effect.Effect<string, unknown, Bench | FileSystem.FileSystem | CommandExecutor.CommandExecutor>

// One row per refusal: how the source is planted, and the words the InstallError must carry.
const ROWS: ReadonlyArray<readonly [label: string, source: Source, says: string]> = [
  ["a relative path", Effect.succeed("relative/path/dirplugin"), "is not an absolute path"],
  ["a missing path", Bench.pipe(Effect.map((b) => join(b.sources, "gone"))), "is not an existing directory"],
  [
    "a plain file",
    plant("afile", { "x.ts": "//\n" }).pipe(Effect.map((dir) => join(dir, "x.ts"))),
    "is not a directory",
  ],
  ["a symlink as the root", linkRoot, "is a symlink"],
  ["a symlink inside the tree", linkInside, "is a symlink"],
  ["a FIFO inside the tree", fifoInside, "is a special file"],
  ["no manifest", plant("nomanifest", { "index.ts": "//\n" }), "no qwbe-package.json"],
  [
    "a manifest naming another package",
    plant("liarplugin", { "qwbe-package.json": manifest({ name: "other" }) }),
    'declares name "other"',
  ],
  ["a manifest promising a missing cube", plugin("ghostplugin", ["ghostcube"]), "no cubes/ghostcube/ directory"],
  [
    "a cube name already on disk",
    plugin("clashplugin", ["notes"], { "cubes/notes/index.ts": "//\n" }),
    "cannot share a name",
  ],
]

layer(Layer.scoped(Bench, bench).pipe(Layer.provideMerge(NodeContext.layer)), {
  timeout: 60_000,
  excludeTestServices: true,
})((it) => {
  for (const [label, source, says] of ROWS) {
    it.effect(`refuses ${label} and leaves the store and plugins empty`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { installer, store, plugins } = yield* Bench
        const error = yield* Effect.flip(installer.stageAndInstall(yield* source))
        expect(error._tag).toBe("InstallError")
        expect(error.message).toContain(says)
        expect([...(yield* fs.readDirectory(store)), ...(yield* fs.readDirectory(plugins))]).toEqual([])
      }),
    )
  }

  // The shelf copy carries the source's provenance stamp but edited bytes: the fingerprint
  // is recomputed from disk, so the edit answers as different content and the shelf stays.
  it.effect("refuses a shelf edited after staging as different content", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { installer, store } = yield* Bench
      const source = yield* cube("shelfpkg")
      const shelf = join(store, "shelfpkg")
      yield* fs.copy(source, shelf)
      yield* fs.writeFileString(join(shelf, "index.ts"), "// edited on the shelf\n")
      yield* fs.writeFileString(
        join(shelf, PROVENANCE),
        JSON.stringify({ fingerprint: packageSourceFingerprint(source) }),
      )
      const error = yield* Effect.flip(installer.stageAndInstall(source))
      expect(error.message).toContain("different content")
      expect(yield* fs.readFileString(join(shelf, "index.ts"))).toBe("// edited on the shelf\n")
    }),
  )
})
