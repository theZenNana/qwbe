// Unit tests for `qwbe check` (QWB-54 ticket 03): the four stages, in order, with the boot
// replaced by its cheap half (the probes/ shape). The sandbox boot itself is proven by
// probes/check-command.mjs -- this file proves the rules, not the process.

import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, describe, it } from "node:test"
import { fileURLToPath } from "node:url"

import { capsSourceFindings, checkPackage, invocationFindings, kernelRoot, probesFindings } from "./check-package.ts"
import { writePack } from "./test-fixture-pack.ts"

const tmpRoots: string[] = []
after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
})

// A package that passes every stage: manifest + one cube, `qwbe check .` as the test script, a
// plain version dependency, a REAL qwbe-core directory under its node_modules (the shape a
// tarball install leaves), and one probe.
const build = (mutate?: (root: string) => void): string => {
  const root = writePack(mkdtempSync(join(tmpdir(), "qwbe-check-command-")), {
    name: "check-pack",
    cubes: { gadgets: `export const cube = { manifest: { name: "gadgets", tables: [] } }\n` },
    extra: {
      "package.json": JSON.stringify({
        name: "check-pack",
        scripts: { test: "qwbe check ." },
        dependencies: { "qwbe-core": "0.0.0" },
      }),
      "probes/selfcheck.mjs": `console.log("probe ran")\n`,
      "node_modules/qwbe-core/package.json": JSON.stringify({ name: "qwbe-core" }),
    },
  })
  tmpRoots.push(root)
  if (mutate) mutate(root)
  return root
}

const resolveTo = (path: string) => () => path

describe("the installed kernel", () => {
  it("kernelRoot() is the package this test file lives in", () => {
    const here = dirname(dirname(fileURLToPath(import.meta.url))) // core/
    assert.equal(realpathSync(kernelRoot()), realpathSync(here))
  })
})

describe("stage 2 -- caps come from the kernel, never from the pack", () => {
  it("a qwbe.config.json in the package is refused, with the reason", () => {
    const root = build((r) => writeFileSync(join(r, "qwbe.config.json"), JSON.stringify({ caps: {} })))
    const findings = capsSourceFindings(root)
    assert.equal(findings.length, 1)
    assert.equal(findings[0]?.rule, "caps-source")
    assert.equal(findings[0]?.file, "qwbe.config.json")
    assert.match(findings[0]?.message ?? "", /caps come from the installed kernel/)
  })

  it("a package without its own config has nothing to refuse", () => {
    assert.deepEqual(capsSourceFindings(build()), [])
  })
})

describe("stage 3 -- probes must exist and run something", () => {
  it("a missing probes/ directory is an error, not a warning", () => {
    const root = build((r) => rmSync(join(r, "probes"), { recursive: true, force: true }))
    const { findings } = probesFindings(root)
    assert.equal(findings[0]?.rule, "probes")
    assert.match(findings[0]?.message ?? "", /probes\/ is missing/)
  })

  it("an empty probes/ directory is an error", () => {
    const root = build((r) => rmSync(join(r, "probes", "selfcheck.mjs")))
    const { findings } = probesFindings(root)
    assert.equal(findings[0]?.rule, "probes")
    assert.match(findings[0]?.message ?? "", /no \*\.mjs in probes\//)
  })

  it("non-.mjs files in probes/ do not count as probes", () => {
    const root = build((r) => {
      rmSync(join(r, "probes", "selfcheck.mjs"))
      writeFileSync(join(r, "probes", "helper.ts"), "export const x = 1\n")
    })
    const { findings, probes } = probesFindings(root)
    assert.equal(findings.length, 1)
    assert.deepEqual(probes, [])
  })

  it("one .mjs probe is found", () => {
    const { findings, probes } = probesFindings(build())
    assert.deepEqual(findings, [])
    assert.deepEqual(probes, ["selfcheck.mjs"])
  })
})

describe("stage 4 -- the invocation is part of the contract", () => {
  it("the intended invocation passes", () => {
    assert.deepEqual(invocationFindings(build()), [])
  })

  it("a scripts.test that is not exactly `qwbe check .` is refused", () => {
    for (const wrong of ["node --test test/*.mjs", "qwbe check ./", "npm run check"]) {
      const root = build((r) => {
        const pkg = readManifest(r)
        pkg.scripts.test = wrong
        writeFileSync(join(r, "package.json"), JSON.stringify(pkg))
      })
      const findings = invocationFindings(root)
      assert.equal(findings.length, 1, wrong)
      assert.equal(findings[0]?.rule, "invocation-test", wrong)
      assert.match(findings[0]?.message ?? "", /must be exactly "qwbe check \." --/, wrong)
    }
  })

  it("file:, link: and github: dependencies are refused, with the reason", () => {
    for (const dep of ["file:../x", "link:../x", "github:owner/qwbe"]) {
      const root = build((r) => {
        const pkg = readManifest(r)
        pkg.dependencies["qwbe-core"] = dep
        writeFileSync(join(r, "package.json"), JSON.stringify(pkg))
      })
      const findings = invocationFindings(root)
      assert.equal(findings.length, 1, dep)
      assert.equal(findings[0]?.rule, "invocation-dependency", dep)
      assert.match(findings[0]?.message ?? "", /names a checkout, not an install/, dep)
    }
  })

  it("a missing qwbe-core dependency is refused", () => {
    const root = build((r) => {
      const pkg = readManifest(r)
      delete pkg.dependencies["qwbe-core"]
      writeFileSync(join(r, "package.json"), JSON.stringify(pkg))
    })
    const findings = invocationFindings(root)
    assert.equal(findings[0]?.rule, "invocation-dependency")
    assert.match(findings[0]?.message ?? "", /is missing/)
  })

  it("a qwbe-core that does not resolve at all is refused", () => {
    const root = build()
    const findings = invocationFindings(root, () => {
      throw new Error("Cannot find module 'qwbe-core/package.json'")
    })
    assert.equal(findings[0]?.rule, "invocation-install")
    assert.match(findings[0]?.message ?? "", /does not resolve/)
  })

  it("npm link is caught: a symlink resolving outside node_modules is refused", () => {
    // A real directory elsewhere stands in for the checkout `npm link` points at.
    const checkout = mkdtempSync(join(tmpdir(), "qwbe-linked-kernel-"))
    tmpRoots.push(checkout)
    writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "qwbe-core" }))
    const root = build()
    const findings = invocationFindings(root, resolveTo(join(checkout, "package.json")))
    assert.equal(findings.length, 1)
    assert.equal(findings[0]?.rule, "invocation-install")
    assert.match(findings[0]?.message ?? "", /not under the package's own node_modules/)
  })
})

describe("the four stages, in order, first failure stops", () => {
  it("a broken cube is reported at stage source", async () => {
    const root = build((r) => {
      writeFileSync(
        join(r, "cubes", "gadgets", "index.ts"),
        `import { readFileSync } from "node:fs"\nexport const x = readFileSync\n`,
      )
      writeFileSync(join(r, "package.json"), "NOT JSON") // later stages must not be reached
      writeFileSync(join(r, "qwbe.config.json"), "{}")
      rmSync(join(r, "probes"), { recursive: true, force: true })
    })
    const report = await checkPackage(root)
    assert.equal(report.ok, false)
    assert.equal(report.failedStage, "source")
    assert.ok(report.findings.some((f) => f.rule === "cube-builtins"))
  })

  it("a pack-side caps file is reported at stage caps", async () => {
    const root = build((r) => {
      writeFileSync(join(r, "qwbe.config.json"), "{}")
      rmSync(join(r, "probes"), { recursive: true, force: true })
      writeFileSync(join(r, "package.json"), "NOT JSON")
    })
    const report = await checkPackage(root)
    assert.equal(report.failedStage, "caps")
  })

  it("an empty probes/ is reported by the probes/ shape check", () => {
    const root = build((r) => {
      rmSync(join(r, "probes"), { recursive: true, force: true })
      writeFileSync(join(r, "package.json"), "NOT JSON")
    })
    const { findings } = probesFindings(root)
    assert.ok(findings.length > 0)
  })

  it("a wrong invocation is reported by the invocation stage directly", () => {
    const root = build((r) => {
      const pkg = readManifest(r)
      pkg.scripts.test = "node --test everything.mjs"
      writeFileSync(join(r, "package.json"), JSON.stringify(pkg))
    })
    const findings = invocationFindings(root)
    assert.equal(findings.length, 1)
  })

  it("a clean package passes the probes/ shape and the invocation check", () => {
    const root = build()
    assert.deepEqual(probesFindings(root).findings, [])
    assert.deepEqual(invocationFindings(root), [])
  })
})

const readPackage = (root: string): string => readFileSync(join(root, "package.json"), "utf8")

/** The fixture manifest, parsed with the shape the invocation rules talk about. */
type PackManifest = { scripts: Record<string, string | undefined>; dependencies: Record<string, string | undefined> }
const readManifest = (root: string): PackManifest => JSON.parse(readPackage(root)) as PackManifest
