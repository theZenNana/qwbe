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
import { PROVENANCE, packageSourceFingerprint } from "../../src/package-source.ts"
import { tempDirectoryAs } from "./temp-env.ts"

// install.ts and install-parts.ts read QWBE_STORE_DIR and QWBE_PLUGINS_DIR at import, so both
// point at scoped temp directories before the installer loads. Sources sit in a third one.
// The source-contract checker is injected as "no findings": every row is refused before it.
const loadBench = Effect.gen(function* () {
  const store = yield* tempDirectoryAs("QWBE_STORE_DIR")
  const plugins = yield* tempDirectoryAs("QWBE_PLUGINS_DIR")
  const sources = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
  const { installerFor } = yield* Effect.promise(() => import("../../src/kernel/install.ts"))
  return { installer: installerFor(() => Promise.resolve([])), store, plugins, sources }
})

class Bench extends Context.Tag("checks/unit/InstallBench")<Bench, Effect.Effect.Success<typeof loadBench>>() {}

type Plant = Effect.Effect<
  string,
  PlatformError.PlatformError,
  Bench | FileSystem.FileSystem | CommandExecutor.CommandExecutor
>

const cubeManifest = (name: string): string => JSON.stringify({ name, kind: "cube" })

const pluginManifest = (name: string, cubes: ReadonlyArray<string>): string =>
  JSON.stringify({ name, kind: "plugin", cubes })

const writeFile = (path: string, text: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    Effect.zipRight(fs.makeDirectory(dirname(path), { recursive: true }), fs.writeFileString(path, text)),
  )

/** Creates `sources/<name>` holding `files` (relative path to text) and returns its path. */
const plant = (name: string, files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const dir = join((yield* Bench).sources, name)
    yield* Effect.forEach(Object.entries(files), ([path, text]) => writeFile(join(dir, path), text))
    return dir
  })

const plantCube = (name: string) => plant(name, { "qwbe-package.json": cubeManifest(name), "index.ts": "//\n" })

const linkAt = (target: string, link: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.symlink(target, link))

const fifoAt = (path: string) =>
  Command.exitCode(Command.make("mkfifo", path)).pipe(Effect.filterOrDieMessage((code) => code === 0, "mkfifo failed"))

const sourcesPath = (name: string) => Effect.map(Bench, (bench) => join(bench.sources, name))

const sourcesRoot = Effect.map(Bench, (bench) => bench.sources)

// One row per refusal: the source to plant, and the words the InstallError must carry.
const ROWS: ReadonlyArray<readonly [label: string, source: Plant, says: string]> = [
  ["a relative path", Effect.succeed("relative/path/dirplugin"), "is not an absolute path"],
  ["a missing path", sourcesPath("gone"), "is not an existing directory"],
  ["a plain file", Effect.map(plant("afile", { "x.ts": "//\n" }), (dir) => join(dir, "x.ts")), "is not a directory"],
  [
    "a symlink as the root",
    Effect.tap(sourcesPath("linkroot"), (link) => Effect.flatMap(plantCube("linktarget"), (dir) => linkAt(dir, link))),
    "is a symlink",
  ],
  [
    "a symlink inside the tree",
    Effect.tap(plantCube("escapeplugin"), (dir) =>
      Effect.flatMap(sourcesRoot, (out) => linkAt(out, join(dir, "sneaky"))),
    ),
    "is a symlink",
  ],
  [
    "a FIFO inside the tree",
    Effect.tap(plantCube("fifoplugin"), (dir) => fifoAt(join(dir, "pipe"))),
    "is a special file",
  ],
  ["no manifest", plant("nomanifest", { "index.ts": "//\n" }), "no qwbe-package.json"],
  [
    "a manifest naming another package",
    plant("liarplugin", { "qwbe-package.json": cubeManifest("other") }),
    'declares name "other"',
  ],
  [
    "a manifest promising a missing cube",
    plant("ghostplugin", { "qwbe-package.json": pluginManifest("ghostplugin", ["ghostcube"]) }),
    "no cubes/ghostcube/ directory",
  ],
  [
    "a cube name already on disk",
    plant("clashplugin", {
      "qwbe-package.json": pluginManifest("clashplugin", ["notes"]),
      "cubes/notes/index.ts": "//\n",
    }),
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
    yield* writeFile(join(shelf, "index.ts"), "// edited on the shelf\n")
    yield* writeFile(join(shelf, PROVENANCE), JSON.stringify({ fingerprint: packageSourceFingerprint(source) }))
  })

layer(Layer.scoped(Bench, loadBench).pipe(Layer.provideMerge(NodeContext.layer)), { excludeTestServices: true })(
  (it) => {
    for (const [label, plantSource, says] of ROWS) {
      it.effect(`refuses ${label} and leaves the store and plugins as they were`, () =>
        Effect.gen(function* () {
          const source = yield* plantSource
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
        const source = yield* plantCube("shelfpkg")
        const shelf = join((yield* Bench).store, "shelfpkg")
        yield* plantEditedShelf(source, shelf)
        expect((yield* refusalFor(source)).message).toContain("different content")
        const kept = yield* Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(join(shelf, "index.ts")))
        expect(kept).toBe("// edited on the shelf\n")
      }),
    )
  },
)
