// Unit test for the shared package contract checker (`qwbe-core/package-contract`).
//
// The fixtures live in a temp directory, not in the repository: a rule that needs a package
// that BREAKS the contract cannot ship inside the tree the gate walks. One fixture package
// passes every rule; single-line mutations of it fail each rule family in turn.

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

import { checkPackageSource } from "./package-contract.ts"

const makePackage = (mutate?: (root: string) => void): string => {
  const root = mkdtempSync(join(tmpdir(), "qwbe-package-contract-"))
  mkdirSync(join(root, "cubes", "demo", "kid"), { recursive: true })
  mkdirSync(join(root, "frontend"), { recursive: true })
  writeFileSync(
    join(root, "qwbe-package.json"),
    JSON.stringify({ name: "demo-pack", kind: "plugin", cubes: ["demo", "demo/kid"] }),
  )
  writeFileSync(
    join(root, "cubes", "demo", "index.ts"),
    `export const cubeParent = { manifest: { name: "demo", screen: true, tables: [] } }\n`,
  )
  writeFileSync(
    join(root, "cubes", "demo", "kid", "index.ts"),
    `export const cubeKid = { manifest: { name: "kid", parent: "demo", tables: [], dataMigration: [{ fromCube: "kid", toCube: "demo/kid", fromPlugin: "demo-pack" }] } }\n`,
  )
  writeFileSync(
    join(root, "frontend", "app.tsx"),
    `import { readFileSync } from "node:fs"\nimport { post } from "../src/anything"\nexport const ui = readFileSync\n`,
  )
  writeFileSync(join(root, "README.md"), "not source\n")
  if (mutate) mutate(root)
  return root
}

const ruleIds = (findings: readonly { rule: string }[]) => findings.map((f) => f.rule).sort()

after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
})
const tmpRoots: string[] = []
const build = (mutate?: (root: string) => void): string => {
  const root = makePackage(mutate)
  tmpRoots.push(root)
  return root
}

describe("package contract checker", () => {
  it("a well-formed package with a frontend/ directory passes every rule", async () => {
    const root = build()
    const findings = await checkPackageSource(root, { readOnly: true, hierarchy: true })
    assert.deepEqual(findings, [])
  })

  it("frontend/ is outside the contract even when it breaks every rule", async () => {
    const root = build()
    const quiet = await checkPackageSource(root, { readOnly: true, hierarchy: true })
    assert.deepEqual(quiet, [])
  })

  it("a manifest naming a cube that is not on disk fails", async () => {
    const root = build()
    writeFileSync(
      join(root, "qwbe-package.json"),
      JSON.stringify({ name: "demo-pack", kind: "plugin", cubes: ["demo", "demo/kid", "ghost"] }),
    )
    const findings = await checkPackageSource(root)
    assert.deepEqual(ruleIds(findings), ["manifest"])
  })

  it("an undeclared cube directory fails", async () => {
    const root = build((r) => {
      mkdirSync(join(r, "cubes", "stowaway"), { recursive: true })
      writeFileSync(
        join(r, "cubes", "stowaway", "index.ts"),
        `export const cube = { manifest: { name: "stowaway" } }\n`,
      )
    })
    const findings = await checkPackageSource(root)
    assert.deepEqual(ruleIds(findings), ["manifest"])
  })

  it("reaching kernel internals fails", async () => {
    const root = build((r) => {
      writeFileSync(
        join(r, "cubes", "demo", "helper.ts"),
        `import { something } from "../../src/kernel/manifest.ts"\nexport const x = something\n`,
      )
    })
    const findings = await checkPackageSource(root)
    assert.deepEqual(ruleIds(findings), ["imports-internal"])
  })

  it("a cube importing node built-ins fails, a comment about it does not", async () => {
    const root = build((r) => {
      writeFileSync(
        join(r, "cubes", "demo", "reader.ts"),
        `// node:fs is forbidden here, and this line says so\nimport { readFileSync } from "node:fs"\nexport const read = readFileSync\n`,
      )
    })
    const findings = await checkPackageSource(root)
    assert.deepEqual(ruleIds(findings), ["cube-builtins"])
  })

  it("readOnly: a mutating endpoint fails", async () => {
    const root = build((r) => {
      writeFileSync(
        join(r, "cubes", "demo", "routes.ts"),
        `import { HttpApiEndpoint } from "@effect/platform"\nexport const e = HttpApiEndpoint.post("/x")\n`,
      )
    })
    const findings = await checkPackageSource(root, { readOnly: true })
    assert.deepEqual(ruleIds(findings), ["readonly-endpoint"])
  })

  it("readOnly: a file write fails", async () => {
    const root = build((r) => {
      writeFileSync(
        join(r, "source.ts"),
        `import { writeFile } from "node:fs/promises"\nexport const save = writeFile\n`,
      )
    })
    const findings = await checkPackageSource(root, { readOnly: true })
    assert.deepEqual(ruleIds(findings), ["readonly-write"])
  })

  it("hierarchy: a child without parent or dataMigration fails", async () => {
    const root = build((r) => {
      writeFileSync(
        join(r, "cubes", "demo", "kid", "index.ts"),
        `export const cubeKid = { manifest: { name: "kid", tables: [] } }\n`,
      )
    })
    const findings = await checkPackageSource(root, { hierarchy: true })
    assert.deepEqual(ruleIds(findings), ["hierarchy", "hierarchy"])
  })

  it("hierarchy: a parent without screen fails", async () => {
    const root = build((r) => {
      writeFileSync(
        join(r, "cubes", "demo", "index.ts"),
        `export const cubeParent = { manifest: { name: "demo", tables: [] } }\n`,
      )
    })
    const findings = await checkPackageSource(root, { hierarchy: true })
    assert.deepEqual(ruleIds(findings), ["hierarchy"])
  })
})
