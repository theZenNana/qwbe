import assert from "node:assert/strict"
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { FileSystem } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { describe, layer } from "@effect/vitest"
import { Cause, Context, Effect, Layer, Option } from "effect"
import { testConfig } from "../test-config.ts"
import { installerFor as installerIn } from "./install.ts"
import { InstallError } from "./manifest.ts"

/** One scratch root for the whole file, removed when the file's scope closes, even on failure. */
class Root extends Context.Tag("Root")<Root, string>() {}
const RootLive = Layer.scoped(
  Root,
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectoryScoped({ prefix: "qwbe-install-scan-" })),
).pipe(Layer.provide(NodeContext.layer))

// The installer reads its store directory from the config it is handed.
const storeIn = (root: string) => join(root, "store")
const installerFor = (root: string) => installerIn(async () => [], testConfig({ QWBE_STORE_DIR: storeIn(root) }))

/** The message of the refusal; the test fails if the effect succeeds instead. */
const refusal = <A>(effect: Effect.Effect<A, InstallError>) => Effect.map(Effect.flip(effect), (e) => e.message)

// The probe fixtures copy a REAL cube (example-plugin's bookmarks): scan and forget read
// manifests and compare fingerprints, they never run the TypeScript contract gate, so no
// staging is needed here and nothing is planted inside the repo itself.
const realCube = join(import.meta.dirname, "..", "..", "..", "core", "plugins", "example-plugin", "cubes", "booktags")

const plantCubePackage = (name: string, dir: string) => {
  mkdirSync(dir, { recursive: true })
  for (const e of readdirSync(realCube, { withFileTypes: true })) {
    e.isDirectory()
      ? cpSync(join(realCube, e.name), join(dir, e.name), { recursive: true })
      : cpSync(join(realCube, e.name), join(dir, e.name))
  }
  writeFileSync(
    join(dir, "qwbe-package.json"),
    `${JSON.stringify({ name, kind: "cube", summary: "fixture" }, null, 2)}\n`,
  )
  return dir
}

layer(RootLive)("install scan", (it) => {
  describe("scanDirectory", () => {
    it.effect("finds valid packages one level deep and skips non-packages", () =>
      Effect.gen(function* () {
        const root = yield* Root
        plantCubePackage("alpha", join(root, "alpha"))
        mkdirSync(join(root, "not-a-package"))
        writeFileSync(join(root, "plain-file.txt"), "x")

        const found = yield* installerFor(root).scanDirectory(root)
        assert.deepEqual(
          found.map((p) => p.name),
          ["alpha"],
        )
        const alpha = found[0]!
        assert.equal(alpha.path, join(root, "alpha"))
        assert.equal(alpha.kind, "cube")
        assert.equal(alpha.shelf, "absent")
        assert.equal(alpha.installed, false)
        assert.ok(alpha.bytes > 0)
      }),
    )

    it.effect("refuses relative paths and missing directories", () =>
      Effect.gen(function* () {
        const root = yield* Root
        assert.match(yield* refusal(installerFor(root).scanDirectory("relative/path")), /not an absolute path/)
        assert.match(yield* refusal(installerFor(root).scanDirectory(join(root, "gone"))), /not an existing directory/)
      }),
    )

    it.effect("reports identical and different shelf content by fingerprint", () =>
      Effect.gen(function* () {
        const root = yield* Root
        const dir = plantCubePackage("beta", join(root, "beta"))
        // A shelf copy with the same bytes -> identical; install-from would reuse it.
        cpSync(dir, join(storeIn(root), "beta"), { recursive: true })
        let found = yield* installerFor(root).scanDirectory(root)
        assert.equal(found.find((p) => p.name === "beta")!.shelf, "identical")
        // Edited bytes -> different; install-from would refuse until the shelf is forgotten.
        writeFileSync(join(dir, "index.ts"), `${readFileSync(join(dir, "index.ts"), "utf8")}\n// edited\n`)
        found = yield* installerFor(root).scanDirectory(root)
        assert.equal(found.find((p) => p.name === "beta")!.shelf, "different")
      }),
    )

    it.effect("a shelf that grew authoring tooling reads different, not identical", () =>
      Effect.gen(function* () {
        const root = yield* Root
        // Review 14b finding 6: the scanner was the one reader still hashing shelves with the lax
        // source rule, so a shelf poisoned with node_modules/ showed "identical" in the UI while
        // installFrom refused it as different content. Shelf hashing is strict (shelfFingerprint,
        // package-source.ts); the call-site pin in package-source.test.ts keeps the next reader
        // from re-deriving a lax variant.
        const dir = plantCubePackage("poisoned", join(root, "poisoned"))
        const shelf = join(storeIn(root), "poisoned")
        cpSync(dir, shelf, { recursive: true })
        mkdirSync(join(shelf, "node_modules", "shadow"), { recursive: true })
        writeFileSync(join(shelf, "node_modules", "shadow", "index.js"), "module.exports = 1\n")
        writeFileSync(join(shelf, ".pi"), "scratch\n")
        const found = yield* installerFor(root).scanDirectory(root)
        assert.equal(found.find((p) => p.name === "poisoned")!.shelf, "different")
      }),
    )
  })

  describe("forgetShelf", () => {
    it.effect("removes an uninstalled shelf copy and then reports nothing to forget", () =>
      Effect.gen(function* () {
        const root = yield* Root
        const dir = plantCubePackage("gamma", join(root, "gamma"))
        cpSync(dir, join(storeIn(root), "gamma"), { recursive: true })
        const removed = yield* installerFor(root).forgetShelf("gamma")
        assert.match(removed.removed, /gamma$/)
        const found = yield* installerFor(root).scanDirectory(root)
        assert.equal(found.find((p) => p.name === "gamma")!.shelf, "absent")
        assert.match(yield* refusal(installerFor(root).forgetShelf("gamma")), /holds no package/)
      }),
    )

    it.effect("refuses names outside the package grammar", () =>
      Effect.gen(function* () {
        assert.match(yield* refusal(installerFor(yield* Root).forgetShelf("../escape")), /not allowed/)
      }),
    )

    it.effect("refuses a shelf whose package is installed (destination exists)", () =>
      Effect.gen(function* () {
        const root = yield* Root
        // The shelf manifest decides the destination; naming the real `auth` cube makes the
        // installed-check true without planting anything inside the repo's own directories.
        const dir = join(storeIn(root), "auth")
        mkdirSync(dir, { recursive: true })
        for (const e of readdirSync(realCube, { withFileTypes: true })) {
          e.isDirectory()
            ? cpSync(join(realCube, e.name), join(dir, e.name), { recursive: true })
            : cpSync(join(realCube, e.name), join(dir, e.name))
        }
        writeFileSync(
          join(dir, "qwbe-package.json"),
          `${JSON.stringify({ name: "auth", kind: "cube", summary: "fixture" }, null, 2)}\n`,
        )
        assert.match(yield* refusal(installerFor(root).forgetShelf("auth")), /is installed/)
      }),
    )
  })

  describe("an unreadable manifest is a system error, not a package refusal (QWB-38)", () => {
    // The PARSE of a malformed manifest is classified as a 400 refusal; the READ of the
    // manifest file itself is not -- an IO error (EACCES, EISDIR) must stay a defect and
    // answer 500, never be dressed up as the package being invalid.
    it.effect("stageAndInstall lets an IO error on the manifest through unwrapped", () =>
      Effect.gen(function* () {
        const root = yield* Root
        mkdirSync(join(root, "unreadable", "qwbe-package.json"), { recursive: true })
        const cause = yield* Effect.flip(Effect.sandbox(installerFor(root).stageAndInstall(join(root, "unreadable"))))
        assert.ok(
          !Option.exists(Cause.failureOption(cause), (e) => e instanceof InstallError),
          "IO error must not be classified as an InstallError",
        )
        // The defect carries the original IO error.
        assert.match(Cause.pretty(cause), /EISDIR/)
      }),
    )
  })
})
