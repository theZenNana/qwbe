import { dirname, join } from "node:path"
import * as Command from "@effect/platform/Command"
import type * as CommandExecutor from "@effect/platform/CommandExecutor"
import type * as PlatformError from "@effect/platform/Error"
import * as FileSystem from "@effect/platform/FileSystem"
import * as NodeContext from "@effect/platform-node/NodeContext"
import { expect, layer } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { installerFor } from "../../src/kernel/install.ts"
import { PROVENANCE, packageSourceFingerprint } from "../../src/package-source.ts"
import { testConfig } from "../../src/test-config.ts"

// The installer gets its store and plugins roots from its config; each is a scoped temp directory,
// and sources sit in a third. The source-contract checker is injected as "no findings": every row
// is refused before it.
const loadBench = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const store = yield* fs.makeTempDirectoryScoped()
  const plugins = yield* fs.makeTempDirectoryScoped()
  const sources = yield* fs.makeTempDirectoryScoped()
  const installer = installerFor(
    () => Promise.resolve([]),
    testConfig({ QWBE_STORE_DIR: store, QWBE_PLUGINS_DIR: plugins }),
  )
  return { installer, store, plugins, sources }
})

class Bench extends Context.Tag("checks/unit/InstallBench")<Bench, Effect.Effect.Success<typeof loadBench>>() {}

/** Plants a source under `sources` and returns the path to hand the installer. */
type Plant = (
  sources: string,
) => Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | CommandExecutor.CommandExecutor>

const cubeManifest = (name: string): string => JSON.stringify({ name, kind: "cube" })

const cube = (name: string) => ({ "qwbe-package.json": cubeManifest(name), "index.ts": "//\n" })

const plugin = (name: string, cubes: ReadonlyArray<string>) => ({
  "qwbe-package.json": JSON.stringify({ name, kind: "plugin", cubes }),
})

/** Writes `files` (relative path to text) under `dir`, creating directories, and returns `dir`. */
const writeTree = (dir: string, files: Readonly<Record<string, string>>) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    Effect.as(
      Effect.forEach(Object.entries(files), ([path, text]) =>
        Effect.zipRight(
          fs.makeDirectory(dirname(join(dir, path)), { recursive: true }),
          fs.writeFileString(join(dir, path), text),
        ),
      ),
      dir,
    ),
  )

const symlink = (target: string, link: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.symlink(target, link))

const mkfifo = (path: string) =>
  Command.exitCode(Command.make("mkfifo", path)).pipe(Effect.filterOrDieMessage((code) => code === 0, "mkfifo failed"))

// One row per refusal: the source to plant, and the words the InstallError must carry.
const ROWS: ReadonlyArray<readonly [label: string, plant: Plant, says: string]> = [
  ["a relative path", () => Effect.succeed("relative/path/dirplugin"), "is not an absolute path"],
  ["a missing path", (sources) => Effect.succeed(join(sources, "gone")), "is not an existing directory"],
  [
    "a plain file",
    (sources) => Effect.map(writeTree(join(sources, "afile"), { "x.ts": "//\n" }), (dir) => join(dir, "x.ts")),
    "is not a directory",
  ],
  [
    "a symlink as the root",
    (sources) =>
      Effect.flatMap(writeTree(join(sources, "linktarget"), cube("linktarget")), (dir) =>
        Effect.as(symlink(dir, join(sources, "linkroot")), join(sources, "linkroot")),
      ),
    "is a symlink",
  ],
  [
    "a symlink inside the tree",
    (sources) =>
      Effect.tap(writeTree(join(sources, "escapeplugin"), cube("escapeplugin")), (dir) =>
        symlink(sources, join(dir, "sneaky")),
      ),
    "is a symlink",
  ],
  [
    "a FIFO inside the tree",
    (sources) =>
      Effect.tap(writeTree(join(sources, "fifoplugin"), cube("fifoplugin")), (dir) => mkfifo(join(dir, "pipe"))),
    "is a special file",
  ],
  ["no manifest", (sources) => writeTree(join(sources, "nomanifest"), { "index.ts": "//\n" }), "no qwbe-package.json"],
  [
    "a manifest naming another package",
    (sources) => writeTree(join(sources, "liarplugin"), { "qwbe-package.json": cubeManifest("other") }),
    'declares name "other"',
  ],
  [
    "a manifest promising a missing cube",
    (sources) => writeTree(join(sources, "ghostplugin"), plugin("ghostplugin", ["ghostcube"])),
    "no cubes/ghostcube/ directory",
  ],
  [
    "a cube name already on disk",
    (sources) =>
      writeTree(join(sources, "clashplugin"), { ...plugin("clashplugin", ["notes"]), "cubes/notes/index.ts": "//\n" }),
    "cannot share a name",
  ],
]

const listing = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const { store, plugins } = yield* Bench
  return { store: yield* fs.readDirectory(store), plugins: yield* fs.readDirectory(plugins) }
})

const refusalFor = (source: string) =>
  Effect.flatMap(Bench, ({ installer }) => Effect.flip(installer.stageAndInstall(source)))

/** A shelf copy of `source` whose bytes were edited after staging but kept the provenance stamp. */
const plantEditedShelf = (source: string, shelf: string) =>
  Effect.gen(function* () {
    yield* Effect.flatMap(FileSystem.FileSystem, (fs) => fs.copy(source, shelf))
    yield* writeTree(shelf, {
      "index.ts": "// edited on the shelf\n",
      [PROVENANCE]: JSON.stringify({ fingerprint: packageSourceFingerprint(source) }),
    })
  })

layer(Layer.scoped(Bench, loadBench).pipe(Layer.provideMerge(NodeContext.layer)), { excludeTestServices: true })(
  (it) => {
    for (const [label, plant, says] of ROWS) {
      it.effect(`refuses ${label} and leaves the store and plugins as they were`, () =>
        Effect.gen(function* () {
          const source = yield* plant((yield* Bench).sources)
          const before = yield* listing
          const refusal = yield* refusalFor(source)
          expect(refusal._tag).toBe("InstallError")
          expect(refusal.message).toContain(says)
          expect(yield* listing).toEqual(before)
        }),
      )
    }

    // The fingerprint of the shelf is recomputed from disk, so the stamp does not vouch for it.
    it.effect("refuses a shelf edited after staging as different content and keeps the edit", () =>
      Effect.gen(function* () {
        const { sources, store } = yield* Bench
        const source = yield* writeTree(join(sources, "shelfpkg"), cube("shelfpkg"))
        const shelf = join(store, "shelfpkg")
        yield* plantEditedShelf(source, shelf)
        expect((yield* refusalFor(source)).message).toContain("different content")
        const kept = yield* Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(join(shelf, "index.ts")))
        expect(kept).toBe("// edited on the shelf\n")
      }),
    )
  },
)
