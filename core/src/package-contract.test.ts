// Unit test for the shared package contract checker (`qwbe-core/package-contract`).
//
// The fixtures live in a temp directory, not in the repository: a rule that needs a package
// that BREAKS the contract cannot ship inside the tree the gate walks. One fixture package
// passes every rule; single-line mutations of it fail each rule family in turn.

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { after, describe, it } from "node:test"

import { pluginsDir } from "./kernel/scan.ts"
import { assertPackageContracts, checkPackageSource } from "./package-contract.ts"

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

// A finding names one broken rule at one file. Asserting only rule ids let a finding naming the
// wrong file pass, so most assertions below compare {rule, file} pairs.
const pairs = (findings: readonly { rule: string; file: string }[]): [string, string][] =>
  findings.map((f): [string, string] => [f.rule, f.file]).sort()

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

  it("a nested frontend/ stays inside the contract", async () => {
    const root = build((r) => {
      mkdirSync(join(r, "cubes", "demo", "frontend"), { recursive: true })
      writeFileSync(join(r, "cubes", "demo", "frontend", "bad.ts"), `import { readFileSync } from "node:fs"\n`)
    })
    const findings = await checkPackageSource(root)
    assert.deepEqual(pairs(findings), [["cube-builtins", "cubes/demo/frontend/bad.ts"]])
  })

  it("top-level probes/, store/, dist/ and build/ are skipped by every rule", async () => {
    const root = build((r) => {
      for (const dir of ["probes", "store", "dist", "build"]) {
        mkdirSync(join(r, dir), { recursive: true })
        writeFileSync(
          join(r, dir, "s.ts"),
          `import { writeFile } from "node:fs/promises"\nexport const w = writeFile\n`,
        )
      }
    })
    assert.deepEqual(await checkPackageSource(root, { readOnly: true }), [])
  })

  it("a manifest naming a cube that is not on disk fails", async () => {
    const root = build()
    writeFileSync(
      join(root, "qwbe-package.json"),
      JSON.stringify({ name: "demo-pack", kind: "plugin", cubes: ["demo", "demo/kid", "ghost"] }),
    )
    const findings = await checkPackageSource(root)
    assert.deepEqual(pairs(findings), [["manifest", "qwbe-package.json"]])
  })

  it("a package without a manifest fails", async () => {
    const root = build((r) => rmSync(join(r, "qwbe-package.json")))
    const findings = await checkPackageSource(root)
    assert.deepEqual(pairs(findings), [["manifest", "qwbe-package.json"]])
  })

  it("a manifest that is not valid JSON fails", async () => {
    const root = build((r) => writeFileSync(join(r, "qwbe-package.json"), "{ not json"))
    const findings = await checkPackageSource(root)
    assert.deepEqual(pairs(findings), [["manifest", "qwbe-package.json"]])
  })

  it("a manifest whose name is not a string fails", async () => {
    const root = build((r) =>
      writeFileSync(join(r, "qwbe-package.json"), JSON.stringify({ name: 42, cubes: ["demo", "demo/kid"] })),
    )
    const findings = await checkPackageSource(root)
    assert.deepEqual(pairs(findings), [["manifest", "qwbe-package.json"]])
  })

  it("a manifest whose kind is not a string fails", async () => {
    const root = build((r) =>
      writeFileSync(
        join(r, "qwbe-package.json"),
        JSON.stringify({ name: "demo-pack", kind: 42, cubes: ["demo", "demo/kid"] }),
      ),
    )
    const findings = await checkPackageSource(root)
    assert.deepEqual(pairs(findings), [["manifest", "qwbe-package.json"]])
  })

  it("a manifest whose cubes is not an array fails", async () => {
    const root = build((r) =>
      writeFileSync(join(r, "qwbe-package.json"), JSON.stringify({ name: "demo-pack", kind: "plugin", cubes: "demo" })),
    )
    const findings = await checkPackageSource(root)
    assert.deepEqual(pairs(findings), [["manifest", "qwbe-package.json"]])
  })

  it("a package without a cubes/ directory fails instead of throwing", async () => {
    const root = build((r) => rmSync(join(r, "cubes"), { recursive: true, force: true }))
    const findings = await checkPackageSource(root)
    assert.deepEqual(pairs(findings), [["manifest", "cubes/"]])
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
    assert.deepEqual(pairs(findings), [["manifest", "cubes/stowaway/index.ts"]])
  })

  it("reaching kernel internals fails", async () => {
    const root = build((r) => {
      writeFileSync(
        join(r, "cubes", "demo", "helper.ts"),
        `import { something } from "../../src/kernel/manifest.ts"\nexport const x = something\n`,
      )
    })
    const findings = await checkPackageSource(root)
    assert.deepEqual(pairs(findings), [["imports-internal", "cubes/demo/helper.ts"]])
  })

  it("reaching kernel internals through a deep relative path fails", async () => {
    const root = build((r) => {
      writeFileSync(
        join(r, "cubes", "demo", "deep.ts"),
        `import { discovery } from "../../../qwbe/core/src/kernel/discovery.ts"\nexport const x = discovery\n`,
      )
    })
    const findings = await checkPackageSource(root)
    assert.deepEqual(pairs(findings), [["imports-internal", "cubes/demo/deep.ts"]])
  })

  it("a cube importing node built-ins fails, a comment about it does not", async () => {
    const root = build((r) => {
      writeFileSync(
        join(r, "cubes", "demo", "reader.ts"),
        `// node:fs is forbidden here, and this line says so\nimport { readFileSync } from "node:fs"\nexport const read = readFileSync\n`,
      )
    })
    const findings = await checkPackageSource(root)
    assert.deepEqual(pairs(findings), [["cube-builtins", "cubes/demo/reader.ts"]])
  })

  it("a cube importing a built-in without the node: prefix fails too", async () => {
    const root = build((r) => {
      writeFileSync(
        join(r, "cubes", "demo", "bare.ts"),
        `import { readFileSync } from "fs"\nexport const read = readFileSync\n`,
      )
    })
    const findings = await checkPackageSource(root)
    assert.deepEqual(pairs(findings), [["cube-builtins", "cubes/demo/bare.ts"]])
  })

  it("multi-line imports and re-exports are inspected", async () => {
    const root = build((r) => {
      writeFileSync(
        join(r, "cubes", "demo", "multi.ts"),
        `import {\n  appendFile,\n} from "fs/promises"\nexport { appendFile }\n`,
      )
    })
    const findings = await checkPackageSource(root)
    assert.deepEqual(pairs(findings), [["cube-builtins", "cubes/demo/multi.ts"]])
  })

  it("one fs/promises import is one finding, not two", async () => {
    const root = build((r) => {
      writeFileSync(
        join(r, "cubes", "demo", "once.ts"),
        `import { writeFile } from "node:fs/promises"\nexport const save = writeFile\n`,
      )
    })
    const findings = await checkPackageSource(root)
    assert.deepEqual(pairs(findings), [["cube-builtins", "cubes/demo/once.ts"]])
  })

  it("a comment or string naming forbidden things raises nothing", async () => {
    const root = build((r) => {
      writeFileSync(
        join(r, "cubes", "demo", "prose.ts"),
        `// writeFile and HttpApiEndpoint.post are forbidden here\nexport const note = "writeFile and HttpApiEndpoint.post in a string"\nexport const x = 1\n`,
      )
    })
    const findings = await checkPackageSource(root, { readOnly: true })
    assert.deepEqual(findings, [])
  })

  it("readOnly: a mutating endpoint fails", async () => {
    const root = build((r) => {
      writeFileSync(
        join(r, "cubes", "demo", "routes.ts"),
        `import { HttpApiEndpoint } from "@effect/platform"\nexport const e = HttpApiEndpoint.post("/x")\n`,
      )
    })
    const findings = await checkPackageSource(root, { readOnly: true })
    assert.deepEqual(pairs(findings), [["readonly-endpoint", "cubes/demo/routes.ts"]])
  })

  it("readOnly: a file write fails", async () => {
    const root = build((r) => {
      writeFileSync(
        join(r, "source.ts"),
        `import { writeFile } from "node:fs/promises"\nexport const save = writeFile\n`,
      )
    })
    const findings = await checkPackageSource(root, { readOnly: true })
    assert.deepEqual(pairs(findings), [["readonly-write", "source.ts"]])
  })

  it("hierarchy: a child without parent or dataMigration fails", async () => {
    const root = build((r) => {
      writeFileSync(
        join(r, "cubes", "demo", "kid", "index.ts"),
        `export const cubeKid = { manifest: { name: "kid", tables: [] } }\n`,
      )
    })
    const findings = await checkPackageSource(root, { hierarchy: true })
    assert.deepEqual(pairs(findings), [
      ["hierarchy", "cubes/demo/kid/index.ts"],
      ["hierarchy", "cubes/demo/kid/index.ts"],
    ])
  })

  it("hierarchy: a parent without screen fails", async () => {
    const root = build((r) => {
      writeFileSync(
        join(r, "cubes", "demo", "index.ts"),
        `export const cubeParent = { manifest: { name: "demo", tables: [] } }\n`,
      )
    })
    const findings = await checkPackageSource(root, { hierarchy: true })
    assert.deepEqual(pairs(findings), [["hierarchy", "cubes/demo/index.ts"]])
  })

  it("hierarchy: a cube whose manifest.name does not match its path fails", async () => {
    const root = build((r) => {
      writeFileSync(
        join(r, "cubes", "demo", "index.ts"),
        `export const cubeParent = { manifest: { name: "wrong", screen: true, tables: [] } }\n`,
      )
    })
    const findings = await checkPackageSource(root, { hierarchy: true })
    assert.deepEqual(pairs(findings), [["hierarchy", "cubes/demo/index.ts"]])
  })

  it("hierarchy: a parent cube that cannot be imported is not also flagged for screen", async () => {
    const root = build((r) => {
      writeFileSync(join(r, "cubes", "demo", "index.ts"), `export const broken = this is not valid\n`)
    })
    const findings = await checkPackageSource(root, { hierarchy: true })
    assert.deepEqual(pairs(findings), [["hierarchy", "cubes/demo/index.ts"]])
  })
})

// The boot gate (QWB-54). The checker resolves a package by NAME under core/plugins, so its
// fixture has to live there rather than in a temp directory. The name starts with a dot, which
// discovery skips: a boot running beside this test cannot mount the broken package.
describe("the boot gate", () => {
  it("refuses a package whose cube imports a built-in from a SUBDIRECTORY", async () => {
    const dir = mkdtempSync(join(pluginsDir, ".contract-gate-"))
    tmpRoots.push(dir)
    mkdirSync(join(dir, "cubes", "bad", "lib"), { recursive: true })
    writeFileSync(join(dir, "qwbe-package.json"), JSON.stringify({ name: "bad", kind: "plugin", cubes: ["bad"] }))
    writeFileSync(join(dir, "cubes", "bad", "index.ts"), `export const cube = { manifest: { name: "bad" } }\n`)
    writeFileSync(
      join(dir, "cubes", "bad", "lib", "deep.ts"),
      `import { readFileSync } from "node:fs"\nexport const peek = readFileSync\n`,
    )
    await assert.rejects(
      () => assertPackageContracts([{ plugin: basename(dir) }]),
      /cube-builtins: cubes\/bad\/lib\/deep\.ts -- node:fs imported by the cube/,
    )
  })

  it("says nothing about the packages that keep the contract", async () => {
    await assertPackageContracts([{ plugin: null }, { plugin: "example-plugin" }])
  })
})
