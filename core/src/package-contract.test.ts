// Unit test for the shared package contract checker (`qwbe-core/package-contract`).
//
// The fixtures live in a temp directory, not in the repository: a rule that needs a package
// that BREAKS the contract cannot ship inside the tree the gate walks. One fixture package
// passes every rule; single-line mutations of it fail each rule family in turn.

import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { FileSystem } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"

import { InstallError, stageAndInstall } from "./kernel/install-from.ts"
import type { CubePackage } from "./kernel/manifest.ts"
import { assertPackageContracts as assertIn, checkPackageSource } from "./package-contract.ts"
import { testConfig, testConfigLayer } from "./test-config.ts"
import { tempDir, writePack } from "./test-fixture-pack.ts"

const { pluginsDir } = testConfig()
const assertPackageContracts = (mounting: ReadonlyArray<{ readonly plugin: string | null }>, env = {}) =>
  assertIn(mounting).pipe(Effect.provide(testConfigLayer(env)))
const check = (...args: Parameters<typeof checkPackageSource>) => Effect.promise(() => checkPackageSource(...args))

const build = (mutate?: (root: string) => void) =>
  Effect.gen(function* () {
    const root = yield* writePack(yield* tempDir("qwbe-package-contract-"), {
      name: "demo-pack",
      cubes: {
        demo: `export const cubeParent = { manifest: { name: "demo", screen: true, tables: [] } }\n`,
        "demo/kid": `export const cubeKid = { manifest: { name: "kid", parent: "demo", tables: [], dataMigration: [{ fromCube: "kid", toCube: "demo/kid", fromPlugin: "demo-pack" }] } }\n`,
      },
      extra: {
        "frontend/app.tsx": `import { readFileSync } from "node:fs"\nimport { post } from "../src/anything"\nexport const ui = readFileSync\n`,
        "README.md": "not source\n",
      },
    })
    if (mutate) mutate(root)
    return root
  })

// A finding names one broken rule at one file. Asserting only rule ids let a finding naming the
// wrong file pass, so most assertions below compare {rule, file} pairs.
const pairs = (findings: readonly { rule: string; file: string }[]): [string, string][] =>
  findings.map((f): [string, string] => [f.rule, f.file]).sort()

// Real clock: the checker and the install gate run tsc and eslint as processes.
const env = layer(NodeContext.layer, { excludeTestServices: true })

env("package contract checker", (it) => {
  it.scoped(
    "stageAndInstall refuses a package the real checker rejects, before anything reaches the shelf (QWB-70)",
    () =>
      Effect.gen(function* () {
        // install-contract.test.ts drives the same path with a stand-in checker (message shape);
        // this file is the one allowed to run the real one, so the integration is proven here.
        const bench = yield* tempDir("qwbe-package-contract-install-")
        const source = join(bench, "ghosted")
        const store = join(bench, "store")
        mkdirSync(source, { recursive: true })
        writeFileSync(
          join(source, "qwbe-package.json"),
          JSON.stringify({ name: "ghosted", kind: "plugin", summary: "declares air", cubes: ["ghost"] }),
        )
        const pkg: CubePackage = {
          name: "ghosted",
          kind: "plugin",
          summary: "declares air",
          cubes: ["ghost"],
          installed: false,
          bytes: 1,
          conflicts: [],
        }
        const install = stageAndInstall({
          storeDir: store,
          readPackageAt: () => Effect.succeed(pkg),
          installExisting: () => Effect.succeed({ ...pkg, installed: true }),
          checkPackageSource,
        })
        const error = yield* Effect.flip(Effect.provide(install(source), testConfigLayer()))
        assert.ok(error instanceof InstallError)
        assert.match(error.message, /source contract/)
        assert.match(error.message, /cubes\//)
        assert.deepEqual(existsSync(store) ? readdirSync(store) : [], [])
      }),
  )

  it.scoped("a well-formed package with a frontend/ directory passes every rule", () =>
    Effect.gen(function* () {
      const root = yield* build()
      const findings = yield* check(root, { readOnly: true, hierarchy: true })
      assert.deepEqual(findings, [])
    }),
  )

  it.scoped("a nested frontend/ stays inside the contract", () =>
    Effect.gen(function* () {
      const root = yield* build((r) => {
        mkdirSync(join(r, "cubes", "demo", "frontend"), { recursive: true })
        writeFileSync(join(r, "cubes", "demo", "frontend", "bad.ts"), `import { readFileSync } from "node:fs"\n`)
      })
      const findings = yield* check(root)
      assert.deepEqual(pairs(findings), [["cube-builtins", "cubes/demo/frontend/bad.ts"]])
    }),
  )

  it.scoped("top-level probes/, store/, dist/ and build/ are skipped by every rule", () =>
    Effect.gen(function* () {
      const root = yield* build((r) => {
        for (const dir of ["probes", "store", "dist", "build"]) {
          mkdirSync(join(r, dir), { recursive: true })
          writeFileSync(
            join(r, dir, "s.ts"),
            `import { writeFile } from "node:fs/promises"\nexport const w = writeFile\n`,
          )
        }
      })
      assert.deepEqual(yield* check(root, { readOnly: true }), [])
    }),
  )

  it.scoped("top-level tools/ and checks/ are developer tooling; a nested cubes/<name>/tools/ is source", () =>
    Effect.gen(function* () {
      const forbidden = `import { loadDefinitions } from "../../../qwbe/core/src/kernel/discovery.ts"\nimport { writeFile } from "node:fs/promises"\nexport const w = [writeFile, loadDefinitions]\n`
      const root = yield* build((r) => {
        for (const dir of ["tools", join("checks", "_layers"), join("cubes", "demo", "tools")]) {
          mkdirSync(join(r, dir), { recursive: true })
          writeFileSync(join(r, dir, "kernel.ts"), forbidden)
        }
      })
      assert.deepEqual(pairs(yield* check(root, { readOnly: true })), [
        ["cube-builtins", "cubes/demo/tools/kernel.ts"],
        ["imports-internal", "cubes/demo/tools/kernel.ts"],
        ["readonly-write", "cubes/demo/tools/kernel.ts"],
      ])
    }),
  )

  it.scoped("a manifest naming a cube that is not on disk fails", () =>
    Effect.gen(function* () {
      const root = yield* build()
      writeFileSync(
        join(root, "qwbe-package.json"),
        JSON.stringify({ name: "demo-pack", kind: "plugin", cubes: ["demo", "demo/kid", "ghost"] }),
      )
      const findings = yield* check(root)
      assert.deepEqual(pairs(findings), [["manifest", "qwbe-package.json"]])
    }),
  )

  it.scoped("a package without a manifest fails", () =>
    Effect.gen(function* () {
      const root = yield* build((r) => rmSync(join(r, "qwbe-package.json")))
      const findings = yield* check(root)
      assert.deepEqual(pairs(findings), [["manifest", "qwbe-package.json"]])
    }),
  )

  it.scoped("a manifest that is not valid JSON fails", () =>
    Effect.gen(function* () {
      const root = yield* build((r) => writeFileSync(join(r, "qwbe-package.json"), "{ not json"))
      const findings = yield* check(root)
      assert.deepEqual(pairs(findings), [["manifest", "qwbe-package.json"]])
    }),
  )

  it.scoped("a manifest whose name is not a string fails", () =>
    Effect.gen(function* () {
      const root = yield* build((r) =>
        writeFileSync(join(r, "qwbe-package.json"), JSON.stringify({ name: 42, cubes: ["demo", "demo/kid"] })),
      )
      const findings = yield* check(root)
      assert.deepEqual(pairs(findings), [["manifest", "qwbe-package.json"]])
    }),
  )

  it.scoped("a manifest whose kind is not a string fails", () =>
    Effect.gen(function* () {
      const root = yield* build((r) =>
        writeFileSync(
          join(r, "qwbe-package.json"),
          JSON.stringify({ name: "demo-pack", kind: 42, cubes: ["demo", "demo/kid"] }),
        ),
      )
      const findings = yield* check(root)
      assert.deepEqual(pairs(findings), [["manifest", "qwbe-package.json"]])
    }),
  )

  it.scoped("a manifest whose cubes is not an array fails", () =>
    Effect.gen(function* () {
      const root = yield* build((r) =>
        writeFileSync(
          join(r, "qwbe-package.json"),
          JSON.stringify({ name: "demo-pack", kind: "plugin", cubes: "demo" }),
        ),
      )
      const findings = yield* check(root)
      assert.deepEqual(pairs(findings), [["manifest", "qwbe-package.json"]])
    }),
  )

  it.scoped("a package without a cubes/ directory fails instead of throwing", () =>
    Effect.gen(function* () {
      const root = yield* build((r) => rmSync(join(r, "cubes"), { recursive: true, force: true }))
      const findings = yield* check(root)
      assert.deepEqual(pairs(findings), [["manifest", "cubes/"]])
    }),
  )

  it.scoped("an undeclared cube directory fails", () =>
    Effect.gen(function* () {
      const root = yield* build((r) => {
        mkdirSync(join(r, "cubes", "stowaway"), { recursive: true })
        writeFileSync(
          join(r, "cubes", "stowaway", "index.ts"),
          `export const cube = { manifest: { name: "stowaway" } }\n`,
        )
      })
      const findings = yield* check(root)
      assert.deepEqual(pairs(findings), [["manifest", "cubes/stowaway/index.ts"]])
    }),
  )

  it.scoped("reaching kernel internals fails", () =>
    Effect.gen(function* () {
      const root = yield* build((r) => {
        writeFileSync(
          join(r, "cubes", "demo", "helper.ts"),
          `import { something } from "../../src/kernel/manifest.ts"\nexport const x = something\n`,
        )
      })
      const findings = yield* check(root)
      assert.deepEqual(pairs(findings), [["imports-internal", "cubes/demo/helper.ts"]])
    }),
  )

  it.scoped("reaching kernel internals through a deep relative path fails", () =>
    Effect.gen(function* () {
      const root = yield* build((r) => {
        writeFileSync(
          join(r, "cubes", "demo", "deep.ts"),
          `import { discovery } from "../../../qwbe/core/src/kernel/discovery.ts"\nexport const x = discovery\n`,
        )
      })
      const findings = yield* check(root)
      assert.deepEqual(pairs(findings), [["imports-internal", "cubes/demo/deep.ts"]])
    }),
  )

  it.scoped("a cube importing node built-ins fails, a comment about it does not", () =>
    Effect.gen(function* () {
      const root = yield* build((r) => {
        writeFileSync(
          join(r, "cubes", "demo", "reader.ts"),
          `// node:fs is forbidden here, and this line says so\nimport { readFileSync } from "node:fs"\nexport const read = readFileSync\n`,
        )
      })
      const findings = yield* check(root)
      assert.deepEqual(pairs(findings), [["cube-builtins", "cubes/demo/reader.ts"]])
    }),
  )

  it.scoped("a cube importing a built-in without the node: prefix fails too", () =>
    Effect.gen(function* () {
      const root = yield* build((r) => {
        writeFileSync(
          join(r, "cubes", "demo", "bare.ts"),
          `import { readFileSync } from "fs"\nexport const read = readFileSync\n`,
        )
      })
      const findings = yield* check(root)
      assert.deepEqual(pairs(findings), [["cube-builtins", "cubes/demo/bare.ts"]])
    }),
  )

  it.scoped("multi-line imports and re-exports are inspected", () =>
    Effect.gen(function* () {
      const root = yield* build((r) => {
        writeFileSync(
          join(r, "cubes", "demo", "multi.ts"),
          `import {\n  appendFile,\n} from "fs/promises"\nexport { appendFile }\n`,
        )
      })
      const findings = yield* check(root)
      assert.deepEqual(pairs(findings), [["cube-builtins", "cubes/demo/multi.ts"]])
    }),
  )

  it.scoped("one fs/promises import is one finding, not two", () =>
    Effect.gen(function* () {
      const root = yield* build((r) => {
        writeFileSync(
          join(r, "cubes", "demo", "once.ts"),
          `import { writeFile } from "node:fs/promises"\nexport const save = writeFile\n`,
        )
      })
      const findings = yield* check(root)
      assert.deepEqual(pairs(findings), [["cube-builtins", "cubes/demo/once.ts"]])
    }),
  )

  it.scoped("a comment or string naming forbidden things raises nothing", () =>
    Effect.gen(function* () {
      const root = yield* build((r) => {
        writeFileSync(
          join(r, "cubes", "demo", "prose.ts"),
          `// writeFile and HttpApiEndpoint.post are forbidden here\nexport const note = "writeFile and HttpApiEndpoint.post in a string"\nexport const x = 1\n`,
        )
      })
      const findings = yield* check(root, { readOnly: true })
      assert.deepEqual(findings, [])
    }),
  )

  it.scoped("readOnly: a mutating endpoint fails", () =>
    Effect.gen(function* () {
      const root = yield* build((r) => {
        writeFileSync(
          join(r, "cubes", "demo", "routes.ts"),
          `import { HttpApiEndpoint } from "@effect/platform"\nexport const e = HttpApiEndpoint.post("/x")\n`,
        )
      })
      const findings = yield* check(root, { readOnly: true })
      assert.deepEqual(pairs(findings), [["readonly-endpoint", "cubes/demo/routes.ts"]])
    }),
  )

  it.scoped("readOnly: a file write fails", () =>
    Effect.gen(function* () {
      const root = yield* build((r) => {
        writeFileSync(
          join(r, "source.ts"),
          `import { writeFile } from "node:fs/promises"\nexport const save = writeFile\n`,
        )
      })
      const findings = yield* check(root, { readOnly: true })
      assert.deepEqual(pairs(findings), [["readonly-write", "source.ts"]])
    }),
  )

  it.scoped("hierarchy: a child without a parent fails -- and an absent dataMigration is honest (ticket 08)", () =>
    Effect.gen(function* () {
      const root = yield* build((r) => {
        writeFileSync(
          join(r, "cubes", "demo", "kid", "index.ts"),
          `export const cubeKid = { manifest: { name: "kid", tables: [] } }\n`,
        )
      })
      const findings = yield* check(root, { hierarchy: true })
      // One finding only: the missing parent. A child with NO dataMigration declares honestly
      // that it has no predecessor -- the old "must declare dataMigration" rule is what forced
      // the invented migration ticket 08 killed (QWB-54).
      assert.deepEqual(pairs(findings), [["hierarchy", "cubes/demo/kid/index.ts"]])
    }),
  )

  it.scoped("hierarchy: a parent without screen fails", () =>
    Effect.gen(function* () {
      const root = yield* build((r) => {
        writeFileSync(
          join(r, "cubes", "demo", "index.ts"),
          `export const cubeParent = { manifest: { name: "demo", tables: [] } }\n`,
        )
      })
      const findings = yield* check(root, { hierarchy: true })
      assert.deepEqual(pairs(findings), [["hierarchy", "cubes/demo/index.ts"]])
    }),
  )

  it.scoped("hierarchy: a cube whose manifest.name does not match its path fails", () =>
    Effect.gen(function* () {
      const root = yield* build((r) => {
        writeFileSync(
          join(r, "cubes", "demo", "index.ts"),
          `export const cubeParent = { manifest: { name: "wrong", screen: true, tables: [] } }\n`,
        )
      })
      const findings = yield* check(root, { hierarchy: true })
      assert.deepEqual(pairs(findings), [["hierarchy", "cubes/demo/index.ts"]])
    }),
  )

  it.scoped("hierarchy: a parent cube that cannot be imported is not also flagged for screen", () =>
    Effect.gen(function* () {
      const root = yield* build((r) => {
        writeFileSync(join(r, "cubes", "demo", "index.ts"), `export const broken = this is not valid\n`)
      })
      const findings = yield* check(root, { hierarchy: true })
      assert.deepEqual(pairs(findings), [["hierarchy", "cubes/demo/index.ts"]])
    }),
  )
})

// The boot gate (QWB-54). The checker resolves a package by NAME under core/plugins, so its
// fixture has to live there rather than in a temp directory. The name starts with a dot, which
// discovery skips: a boot running beside this test cannot mount the broken package.
env("the boot gate", (it) => {
  it.scoped("refuses a package whose cube imports a built-in from a SUBDIRECTORY", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir(".contract-gate-", pluginsDir)
      mkdirSync(join(dir, "cubes", "bad", "lib"), { recursive: true })
      writeFileSync(join(dir, "qwbe-package.json"), JSON.stringify({ name: "bad", kind: "plugin", cubes: ["bad"] }))
      writeFileSync(join(dir, "cubes", "bad", "index.ts"), `export const cube = { manifest: { name: "bad" } }\n`)
      writeFileSync(
        join(dir, "cubes", "bad", "lib", "deep.ts"),
        `import { readFileSync } from "node:fs"\nexport const peek = readFileSync\n`,
      )
      assert.match(
        (yield* Effect.flip(assertPackageContracts([{ plugin: basename(dir) }]))).message,
        /cube-builtins: cubes\/bad\/lib\/deep\.ts -- node:fs imported by the cube/,
      )
    }),
  )

  it.scoped("says nothing about the packages that keep the contract", () =>
    Effect.gen(function* () {
      yield* assertPackageContracts([{ plugin: null }, { plugin: "example-plugin" }])
    }),
  )

  // An INSTALLED package keeps its manifest in the store, not next to its cubes. A probe that
  // plants a store of its own (`QWBE_STORE_DIR`) must not make the real store invisible: the
  // first time one did, the boot refused with "package manifest is missing" about a package
  // that was fine, and every probe after it in the chain never ran.
  it.scoped("finds an installed package's manifest in the real store even when the override is empty", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir(".contract-store-", pluginsDir)
      const plugin = basename(dir)
      mkdirSync(join(dir, "cubes", "shelved"), { recursive: true })
      writeFileSync(
        join(dir, "cubes", "shelved", "index.ts"),
        'export const cube = { manifest: { name: "shelved" } }\n',
      )
      const store = join(pluginsDir, "..", "store", plugin)
      const fs = yield* FileSystem.FileSystem
      yield* Effect.acquireRelease(fs.makeDirectory(store, { recursive: true }), () =>
        Effect.ignore(fs.remove(store, { recursive: true })),
      )
      writeFileSync(
        join(store, "qwbe-package.json"),
        JSON.stringify({ name: plugin, kind: "plugin", cubes: ["shelved"] }),
      )

      const empty = yield* tempDir("qwbe-empty-store-")
      yield* assertPackageContracts([{ plugin }], { QWBE_STORE_DIR: empty })
    }),
  )
})
