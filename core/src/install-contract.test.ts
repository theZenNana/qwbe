import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { NodeContext } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { contractValidationParent, isOutsideDiscoveryRoots } from "./install-contract.ts"
import { InstallError, stageAndInstall } from "./kernel/install-from.ts"
import type { CubePackage } from "./kernel/manifest.ts"
import { testConfigLayer } from "./test-config.ts"
import { tempDir } from "./test-fixture-pack.ts"

// Real clock: the gate runs tsc and eslint as processes.
layer(NodeContext.layer, { excludeTestServices: true })("install-from static contract gate", (it) => {
  it("keeps validation copies outside runtime discovery roots", () => {
    assert.equal(isOutsideDiscoveryRoots(contractValidationParent), true)
  })

  it.scoped(
    "refuses a TypeScript-invalid cube before publishing it to the store",
    () =>
      Effect.gen(function* () {
        const bench = yield* tempDir("qwbe-install-contract-")
        const source = join(bench, "broken-cube")
        const store = join(bench, "store")
        mkdirSync(join(source, "cubes", "broken-cube"), { recursive: true })
        writeFileSync(
          join(source, "qwbe-package.json"),
          JSON.stringify({ name: "broken-cube", kind: "plugin", cubes: ["broken-cube"] }),
        )
        writeFileSync(
          join(source, "cubes", "broken-cube", "index.ts"),
          "const mustBeText: string = 42\nexport { mustBeText }\n",
        )

        const pkg: CubePackage = {
          name: "broken-cube",
          kind: "plugin",
          summary: "invalid TypeScript",
          cubes: ["broken-cube"],
          installed: false,
          bytes: 1,
          conflicts: [],
        }

        const install = stageAndInstall({
          storeDir: store,
          readPackageAt: () => Effect.succeed(pkg),
          installExisting: () => Effect.succeed({ ...pkg, installed: true }),
          checkPackageSource: async () => [], // no source findings: this case is about the stage, not the checker
        })

        const error = yield* Effect.flip(Effect.provide(install(source), testConfigLayer()))
        assert.ok(error instanceof InstallError)
        assert.match(error.message, /TypeScript contract gate/)
        assert.match(error.message, /TS2322/)
        assert.deepEqual(existsSync(store) ? readdirSync(store) : [], [])
      }),
    // Spawns a real tsc: about 3s alone, over the 5s default under full-suite load.
    60_000,
  )

  // ponytail: spawns a real tsc, ~5s; vitest default is 5s so give it headroom
  it.scoped(
    "refuses deterministic lint defects before publishing",
    () =>
      Effect.gen(function* () {
        const bench = yield* tempDir("qwbe-install-lint-")
        const source = join(bench, "unsafe-cube")
        const store = join(bench, "store")
        mkdirSync(join(source, "cubes", "unsafe-cube"), { recursive: true })
        writeFileSync(
          join(source, "qwbe-package.json"),
          JSON.stringify({ name: "unsafe-cube", kind: "plugin", cubes: ["unsafe-cube"] }),
        )
        writeFileSync(
          join(source, "cubes", "unsafe-cube", "index.ts"),
          `import { HttpApiGroup } from "@effect/platform"
import { defineCube } from "qwbe-core/cube"
const group = HttpApiGroup.make("unsafe-cube")
export const cube = defineCube(group, {
  manifest: { name: "unsafe-cube", tables: [], requiresAuth: false },
  create: () => ({ handlers: {} }),
})
export const unsafe: any = 1
`,
        )
        const pkg: CubePackage = {
          name: "unsafe-cube",
          kind: "plugin",
          summary: "unsafe TypeScript",
          cubes: ["unsafe-cube"],
          installed: false,
          bytes: 1,
          conflicts: [],
        }

        const install = stageAndInstall({
          storeDir: store,
          readPackageAt: () => Effect.succeed(pkg),
          installExisting: () => Effect.succeed({ ...pkg, installed: true }),
          checkPackageSource: async () => [], // no source findings: this case is about the stage, not the checker
        })
        assert.match(
          (yield* Effect.flip(Effect.provide(install(source), testConfigLayer()))).message,
          /no-explicit-any/,
        )
        assert.deepEqual(existsSync(store) ? readdirSync(store) : [], [])
      }),
    60_000,
  )

  it.scoped("refuses a package that breaks the source contract, with the checker's own findings", () =>
    Effect.gen(function* () {
      const bench = yield* tempDir("qwbe-install-source-contract-")
      const source = join(bench, "ghosted")
      const store = join(bench, "store")
      // A manifest promising a cube the tree does not carry: exactly what the source contract
      // (the boot gate's checker) refuses, now before anything reaches the shelf.
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
        // The checker is injected (QWB-70) - this test wires a stand-in so the refusal path
        // and message shape are exercised; the checker's own behavior is covered by
        // package-contract.test.ts, which is the one file allowed to run it.
        checkPackageSource: async () => [
          { rule: "cubes/", file: "qwbe-package.json", message: "cubes/ -- the cubes/ directory is missing" },
        ],
      })
      const error = yield* Effect.flip(Effect.provide(install(source), testConfigLayer()))
      assert.ok(error instanceof InstallError)
      assert.match(error.message, /source contract/)
      assert.match(error.message, /cubes\/ -- the cubes\/ directory is missing/)
      assert.deepEqual(existsSync(store) ? readdirSync(store) : [], [])
    }),
  )

  // A pack's top-level tools/ and checks/ are its developer tooling (crm-pack's checks/live/*.test.ts
  // import vitest and helpers the kernel does not carry): the gate must not typecheck them and the
  // shelf must not carry them. A nested cubes/<name>/tools/ is cube source like any other.
  it.scoped(
    "installs a pack whose top-level tools/ and checks/ import modules the kernel lacks",
    () =>
      Effect.gen(function* () {
        const bench = yield* tempDir("qwbe-install-dev-dirs-")
        const source = join(bench, "tooled")
        const store = join(bench, "store")
        const lacking = `import { missing } from "qwbe-kernel-lacks-this"\nexport const x = missing\n`
        for (const dir of ["tools", join("checks", "live"), join("cubes", "tooled", "tools")]) {
          mkdirSync(join(source, dir), { recursive: true })
        }
        writeFileSync(
          join(source, "qwbe-package.json"),
          JSON.stringify({ name: "tooled", kind: "plugin", cubes: ["tooled"] }),
        )
        writeFileSync(join(source, "tools", "x.ts"), lacking)
        writeFileSync(join(source, "checks", "live", "boot.test.ts"), lacking)
        writeFileSync(join(source, "cubes", "tooled", "tools", "helper.ts"), "export const helper = 1\n")
        writeFileSync(
          join(source, "cubes", "tooled", "index.ts"),
          `import { HttpApiGroup } from "@effect/platform"
import { defineCube } from "qwbe-core/cube"
const group = HttpApiGroup.make("tooled")
export const cube = defineCube(group, {
  manifest: { name: "tooled", tables: [], requiresAuth: false },
  create: () => ({ handlers: {} }),
})
`,
        )
        const pkg: CubePackage = {
          name: "tooled",
          kind: "plugin",
          summary: "pack with developer tooling",
          cubes: ["tooled"],
          installed: false,
          bytes: 1,
          conflicts: [],
        }

        const install = stageAndInstall({
          storeDir: store,
          readPackageAt: () => Effect.succeed(pkg),
          installExisting: () => Effect.succeed({ ...pkg, installed: true }),
          checkPackageSource: async () => [], // no source findings: this case is about the stage, not the checker
        })
        const result = yield* Effect.provide(install(source), testConfigLayer())
        assert.equal(result.staged, true)
        assert.equal(existsSync(join(store, "tooled", "tools")), false)
        assert.equal(existsSync(join(store, "tooled", "checks")), false)
        assert.equal(existsSync(join(store, "tooled", "cubes", "tooled", "tools", "helper.ts")), true)
      }),
    60_000,
  )

  it.scoped("publishes source without local dependency and repository metadata", () =>
    Effect.gen(function* () {
      const bench = yield* tempDir("qwbe-install-clean-source-")
      const source = join(bench, "clean-source")
      const store = join(bench, "store")
      mkdirSync(join(source, "node_modules", ".bin"), { recursive: true })
      mkdirSync(join(source, ".venv", "bin"), { recursive: true })
      mkdirSync(join(source, ".git"), { recursive: true })
      mkdirSync(join(source, "probes"), { recursive: true })
      writeFileSync(join(source, "index.ts"), "export const source = true\n")
      writeFileSync(join(source, "package.json"), '{"private":true}\n')
      writeFileSync(join(source, "package-lock.json"), "{}\n")
      writeFileSync(join(source, "tsconfig.json"), "{}\n")
      writeFileSync(join(source, "source-contract.test.mjs"), "authoring test\n")
      writeFileSync(join(source, "probes", "runtime.mjs"), "authoring probe\n")
      writeFileSync(join(source, "node_modules", "dependency.js"), "generated\n")
      writeFileSync(join(source, ".venv", "bin", "python"), "generated runtime\n")
      writeFileSync(join(source, ".git", "config"), "private local metadata\n")
      symlinkSync(join(source, "node_modules", "dependency.js"), join(source, "node_modules", ".bin", "dependency"))

      const pkg: CubePackage = {
        name: "clean-source",
        kind: "cube",
        summary: "source with local tooling",
        cubes: ["clean-source"],
        installed: false,
        bytes: 1,
        // This unit test exercises staging only; package contracts have dedicated tests above.
        conflicts: ["skip-static-contract-fixture"],
      }

      const install = stageAndInstall({
        storeDir: store,
        readPackageAt: () => Effect.succeed(pkg),
        installExisting: () => Effect.succeed({ ...pkg, installed: true }),
        checkPackageSource: async () => [], // no source findings: this case is about the stage, not the checker
      })
      const result = yield* Effect.provide(install(source), testConfigLayer())
      assert.equal(result.staged, true)
      assert.equal(existsSync(join(store, "clean-source", "index.ts")), true)
      assert.equal(existsSync(join(store, "clean-source", "node_modules")), false)
      assert.equal(existsSync(join(store, "clean-source", ".venv")), false)
      assert.equal(existsSync(join(store, "clean-source", ".git")), false)
      assert.equal(existsSync(join(store, "clean-source", "package.json")), false)
      assert.equal(existsSync(join(store, "clean-source", "package-lock.json")), false)
      assert.equal(existsSync(join(store, "clean-source", "tsconfig.json")), false)
      assert.equal(existsSync(join(store, "clean-source", "source-contract.test.mjs")), false)
      assert.equal(existsSync(join(store, "clean-source", "probes")), false)
    }),
  )
})
