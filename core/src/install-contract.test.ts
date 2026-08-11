import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
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
})
