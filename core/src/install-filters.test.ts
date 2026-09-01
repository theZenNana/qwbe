// One content rule for every copy of a package (QWB-54): repo -> shelf (staging), shelf ->
// sandbox (`qwbe check`), shelf -> plugins (install) must all judge a file the same way.
// includePackageSourcePath + isBookkeeping in package-source.ts ARE that rule. This test
// copies one fixture through the REAL sandbox filter (stageSandbox) and the REAL install
// filter (installerFor().install) and demands the same file list -- the day someone writes
// a third private filter again, the two paths visibly diverge here.

import assert from "node:assert/strict"
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, sep } from "node:path"
import { describe, it } from "node:test"

// The store and plugins roots are read from the environment at module load: set them
// before any kernel module is imported, hence the dynamic imports below.
const bench = mkdtempSync(join(tmpdir(), "qwbe-install-filters-"))
process.env.QWBE_STORE_DIR = join(bench, "store")
process.env.QWBE_PLUGINS_DIR = join(bench, "plugins")

const { installerFor } = await import("./kernel/install.ts")
const { stageSandbox } = await import("./check-package.ts")

const NAME = "filter-pack"

const buildFixture = (dir: string): void => {
  mkdirSync(join(dir, "cubes", "x"), { recursive: true })
  mkdirSync(join(dir, "test"), { recursive: true })
  mkdirSync(join(dir, ".pi"), { recursive: true })
  mkdirSync(join(dir, "docs"), { recursive: true })
  writeFileSync(join(dir, "cubes", "x", "index.ts"), "export const x = 1\n")
  writeFileSync(join(dir, "cubes", "x", "package.json"), "{}\n")
  writeFileSync(join(dir, "test", "a.ts"), "export const a = 1\n")
  writeFileSync(join(dir, ".pi", "x"), "scratch\n")
  writeFileSync(join(dir, "docs", "r.md"), "# r\n")
  writeFileSync(join(dir, "qwbe-package.json"), JSON.stringify({ name: NAME, kind: "plugin", cubes: ["x"] }))
}

const filesUnder = (dir: string): Array<string> => {
  const out: Array<string> = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else out.push(relative(dir, path).split(sep).join("/"))
    }
  }
  walk(dir)
  return out.sort()
}

describe("one content rule for every copy of a package", () => {
  it("the qwbe check sandbox and the installed copy are the same artifact", async () => {
    const source = join(bench, "source")
    buildFixture(source)

    // 1. The sandbox filter: source -> plugins/<name>, what `qwbe check` boots.
    const sandbox = stageSandbox(source, NAME, false)
    try {
      const sandboxFiles = filesUnder(join(sandbox.plugins, NAME))

      // 2. The install filter: shelf -> plugins/<name>, what a real install leaves behind.
      const shelf = join(process.env.QWBE_STORE_DIR ?? "", NAME)
      mkdirSync(process.env.QWBE_STORE_DIR ?? "", { recursive: true })
      cpSync(source, shelf, { recursive: true })
      const installed = await import("effect").then(({ Effect }) => Effect.runPromise(installerFor().install(NAME)))
      assert.ok(installed.installed)
      const installedFiles = filesUnder(join(process.env.QWBE_PLUGINS_DIR ?? "", NAME))

      // The copy `qwbe check` judged is byte-for-byte the file set an install would ship:
      // authoring tool state (test/, .pi/, docs/, package.json) present in NEITHER.
      assert.ok(sandboxFiles.includes("cubes/x/index.ts"), "the cube itself must be copied")
      assert.deepEqual(installedFiles, sandboxFiles)
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true })
    }
  })

  it("staging tool state stays out of both copies", () => {
    // Belt and braces on the shape itself, readable without the equivalence above. The rule is
    // first-segment: top-level tooling (test/, .pi/, docs/, a top-level package.json) stays
    // out; a cube's own package.json at depth is content and ships.
    const source = join(bench, "shape")
    buildFixture(source)
    writeFileSync(join(source, "package.json"), '{"name": "filter-pack"}\n')
    const sandbox = stageSandbox(source, NAME, false)
    try {
      const files = filesUnder(join(sandbox.plugins, NAME))
      assert.deepEqual(files, ["cubes/x/index.ts", "cubes/x/package.json"])
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true })
    }
  })
})
