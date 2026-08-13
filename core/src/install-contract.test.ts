import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { contractValidationParent, isOutsideDiscoveryRoots } from "./install-contract.ts"
import { InstallError, stageAndInstall } from "./kernel/install-from.ts"
import type { CubePackage } from "./kernel/manifest.ts"

describe("install-from static contract gate", () => {
  it("keeps validation copies outside runtime discovery roots", () => {
    assert.equal(isOutsideDiscoveryRoots(contractValidationParent), true)
  })

  it("refuses a TypeScript-invalid cube before publishing it to the store", () => {
    const bench = mkdtempSync(join(tmpdir(), "qwbe-install-contract-"))
    const source = join(bench, "broken-cube")
    const store = join(bench, "store")
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, "index.ts"), "const mustBeText: string = 42\nexport { mustBeText }\n")

    const pkg: CubePackage = {
      name: "broken-cube",
      kind: "cube",
      summary: "invalid TypeScript",
      cubes: ["broken-cube"],
      installed: false,
      bytes: 1,
      conflicts: [],
    }

    try {
      const install = stageAndInstall({
        storeDir: store,
        readPackageAt: () => pkg,
        installExisting: () => ({ ...pkg, installed: true }),
      })

      assert.throws(
        () => install(source),
        (error: unknown) => {
          assert.ok(error instanceof InstallError)
          assert.match(error.message, /TypeScript contract gate/)
          assert.match(error.message, /TS2322/)
          return true
        },
      )
      assert.deepEqual(existsSync(store) ? readdirSync(store) : [], [])
    } finally {
      rmSync(bench, { recursive: true, force: true })
    }
  })

  it("refuses deterministic lint defects before publishing", () => {
    const bench = mkdtempSync(join(tmpdir(), "qwbe-install-lint-"))
    const source = join(bench, "unsafe-cube")
    const store = join(bench, "store")
    mkdirSync(source, { recursive: true })
    writeFileSync(
      join(source, "index.ts"),
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
      kind: "cube",
      summary: "unsafe TypeScript",
      cubes: ["unsafe-cube"],
      installed: false,
      bytes: 1,
      conflicts: [],
    }

    try {
      const install = stageAndInstall({
        storeDir: store,
        readPackageAt: () => pkg,
        installExisting: () => ({ ...pkg, installed: true }),
      })
      assert.throws(() => install(source), /no-explicit-any/)
      assert.deepEqual(existsSync(store) ? readdirSync(store) : [], [])
    } finally {
      rmSync(bench, { recursive: true, force: true })
    }
  })

  it("publishes source without local dependency and repository metadata", () => {
    const bench = mkdtempSync(join(tmpdir(), "qwbe-install-clean-source-"))
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

    try {
      const install = stageAndInstall({
        storeDir: store,
        readPackageAt: () => pkg,
        installExisting: () => ({ ...pkg, installed: true }),
      })
      assert.equal(install(source).staged, true)
      assert.equal(existsSync(join(store, "clean-source", "index.ts")), true)
      assert.equal(existsSync(join(store, "clean-source", "node_modules")), false)
      assert.equal(existsSync(join(store, "clean-source", ".venv")), false)
      assert.equal(existsSync(join(store, "clean-source", ".git")), false)
      assert.equal(existsSync(join(store, "clean-source", "package.json")), false)
      assert.equal(existsSync(join(store, "clean-source", "package-lock.json")), false)
      assert.equal(existsSync(join(store, "clean-source", "tsconfig.json")), false)
      assert.equal(existsSync(join(store, "clean-source", "source-contract.test.mjs")), false)
      assert.equal(existsSync(join(store, "clean-source", "probes")), false)
    } finally {
      rmSync(bench, { recursive: true, force: true })
    }
  })
})
