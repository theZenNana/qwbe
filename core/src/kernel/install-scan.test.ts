import assert from "node:assert/strict"
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { Effect } from "effect"

// The store directory is resolved at module load, so the fixture store must exist BEFORE the
// installer module is imported - hence the dynamic import below.
const root = mkdtempSync(join(tmpdir(), "qwbe-install-scan-"))
const store = join(root, "store")
process.env.QWBE_STORE_DIR = store

const { installerFor } = await import("./install.ts")

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

describe("scanDirectory", () => {
  it("finds valid packages one level deep and skips non-packages", async () => {
    plantCubePackage("alpha", join(root, "alpha"))
    mkdirSync(join(root, "not-a-package"))
    writeFileSync(join(root, "plain-file.txt"), "x")

    const found = await Effect.runPromise(installerFor().scanDirectory(root))
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
  })

  it("refuses relative paths and missing directories", async () => {
    await assert.rejects(() => Effect.runPromise(installerFor().scanDirectory("relative/path")), /not an absolute path/)
    await assert.rejects(
      () => Effect.runPromise(installerFor().scanDirectory(join(root, "gone"))),
      /not an existing directory/,
    )
  })

  it("reports identical and different shelf content by fingerprint", async () => {
    const dir = plantCubePackage("beta", join(root, "beta"))
    // A shelf copy with the same bytes -> identical; install-from would reuse it.
    cpSync(dir, join(store, "beta"), { recursive: true })
    let found = await Effect.runPromise(installerFor().scanDirectory(root))
    assert.equal(found.find((p) => p.name === "beta")!.shelf, "identical")
    // Edited bytes -> different; install-from would refuse until the shelf is forgotten.
    writeFileSync(join(dir, "index.ts"), `${readFileSync(join(dir, "index.ts"), "utf8")}\n// edited\n`)
    found = await Effect.runPromise(installerFor().scanDirectory(root))
    assert.equal(found.find((p) => p.name === "beta")!.shelf, "different")
  })
})

describe("forgetShelf", () => {
  it("removes an uninstalled shelf copy and then reports nothing to forget", async () => {
    const dir = plantCubePackage("gamma", join(root, "gamma"))
    cpSync(dir, join(store, "gamma"), { recursive: true })
    const removed = await Effect.runPromise(installerFor().forgetShelf("gamma"))
    assert.match(removed.removed, /gamma$/)
    assert.equal(
      await Effect.runPromise(installerFor().scanDirectory(root)).then((f) => f.find((p) => p.name === "gamma")!.shelf),
      "absent",
    )
    await assert.rejects(() => Effect.runPromise(installerFor().forgetShelf("gamma")), /holds no package/)
  })

  it("refuses names outside the package grammar", async () => {
    await assert.rejects(() => Effect.runPromise(installerFor().forgetShelf("../escape")), /not allowed/)
  })

  it("refuses a shelf whose package is installed (destination exists)", async () => {
    // The shelf manifest decides the destination; naming the real `auth` cube makes the
    // installed-check true without planting anything inside the repo's own directories.
    const dir = join(store, "auth")
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
    await assert.rejects(() => Effect.runPromise(installerFor().forgetShelf("auth")), /is installed/)
  })
})

rmSync(root, { recursive: true, force: true })
