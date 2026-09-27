// One content rule for every copy of a package (QWB-54): repo -> shelf (staging), shelf ->
// sandbox (`qwbe check`), shelf -> plugins (install) must all judge a file the same way.
// includePackageSourcePath + isBookkeeping in package-source.ts ARE that rule. This test
// copies one fixture through the REAL sandbox filter (stageSandbox) and the REAL install
// filter (installerFor().install) and demands the same file list -- the day someone writes
// a third private filter again, the two paths visibly diverge here.

import assert from "node:assert/strict"
import { cpSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { NodeContext } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { kernelRoot, stageSandbox } from "./check-package.ts"
import { installerFor } from "./kernel/install.ts"
import { testConfig } from "./test-config.ts"
import { tempDir, writePack } from "./test-fixture-pack.ts"

// The installer gets its store and plugins roots from the config it is handed.
const benchDirs = Effect.map(tempDir("qwbe-install-filters-"), (bench) => {
  const storeDir = join(bench, "store")
  const pluginsDir = join(bench, "plugins")
  return { bench, storeDir, pluginsDir, config: testConfig({ QWBE_STORE_DIR: storeDir, QWBE_PLUGINS_DIR: pluginsDir }) }
})

/** The files `qwbe check` would mount for `source`, read before the sandbox is removed. */
const sandboxFiles = (source: string) =>
  Effect.scoped(
    Effect.flatMap(kernelRoot, (root) =>
      Effect.map(stageSandbox(source, NAME, root), (sandbox) => filesUnder(join(sandbox.plugins, NAME))),
    ),
  )

const NAME = "filter-pack"

const buildFixture = (dir: string) =>
  writePack(dir, {
    name: NAME,
    cubes: { x: "export const x = 1\n" },
    extra: {
      "cubes/x/package.json": "{}\n",
      "test/a.ts": "export const a = 1\n",
      ".pi/x": "scratch\n",
      "docs/r.md": "# r\n",
    },
  })

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

// Real clock: staging the sandbox runs real processes.
layer(NodeContext.layer, { excludeTestServices: true })("one content rule for every copy of a package", (it) => {
  it.scoped("the qwbe check sandbox and the installed copy are the same artifact", () =>
    Effect.gen(function* () {
      const { bench, storeDir, pluginsDir, config } = yield* benchDirs
      const source = join(bench, "source")
      yield* buildFixture(source)

      // 1. The sandbox filter: source -> plugins/<name>, what `qwbe check` boots.
      const mounted = yield* sandboxFiles(source)

      // 2. The install filter: shelf -> plugins/<name>, what a real install leaves behind.
      const shelf = join(storeDir, NAME)
      mkdirSync(storeDir, { recursive: true })
      cpSync(source, shelf, { recursive: true })
      const installed = yield* installerFor(async () => [], config).install(NAME)
      assert.ok(installed.installed)
      const installedFiles = filesUnder(join(pluginsDir, NAME))

      // The copy `qwbe check` judged is byte-for-byte the file set an install would ship:
      // authoring tool state (test/, .pi/, docs/, package.json) present in NEITHER.
      assert.ok(mounted.includes("cubes/x/index.ts"), "the cube itself must be copied")
      assert.deepEqual(installedFiles, mounted)
    }),
  )

  it.scoped("staging tool state stays out of both copies", () =>
    Effect.gen(function* () {
      const { bench } = yield* benchDirs
      // Belt and braces on the shape itself, readable without the equivalence above. The rule is
      // first-segment: top-level tooling (test/, .pi/, docs/, a top-level package.json) stays
      // out; a cube's own package.json at depth is content and ships.
      const source = join(bench, "shape")
      yield* buildFixture(source)
      writeFileSync(join(source, "package.json"), '{"name": "filter-pack"}\n')
      assert.deepEqual(yield* sandboxFiles(source), ["cubes/x/index.ts", "cubes/x/package.json"])
    }),
  )
})
