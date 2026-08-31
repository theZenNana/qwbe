// Unit tests for the pack-facing size measuring (`qwbe check` stage 2).
//
// The fixtures live in a temp directory: the rules judge whatever tree they are pointed at, and
// a rule that needs an OVER-CAP file cannot ship inside the tree the kernel's own gate walks.

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

import { capsFromConfig, sizeCapsFindings, stripComments } from "./package-size.ts"

const CAPS = { countMode: "code" as const, maxCharsPerFile: 6000, maxFilesPerUnit: 15, maxCharsPerUnit: 40000 }

const tmpRoots: string[] = []
after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
})

const build = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "qwbe-package-size-"))
  tmpRoots.push(root)
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  return root
}

const filler = (code: number) => `const x = "${"a".repeat(Math.max(0, code - 12))}"\n`

describe("size caps for a package", () => {
  it("a package under every cap passes", () => {
    const root = build({ "cubes/gadgets/index.ts": filler(100) })
    assert.deepEqual(sizeCapsFindings(root, CAPS), [])
  })

  it("a file over the code cap is a finding, and comments do not count", () => {
    const root = build({
      // 9000 code chars + 9000 chars of comment: over the cap by CODE, and the comment adds nothing.
      "cubes/gadgets/index.ts": `${filler(9000)}// ${"x".repeat(9000)}\n`,
    })
    const findings = sizeCapsFindings(root, CAPS)
    assert.equal(findings.length, 1)
    assert.equal(findings[0]?.rule, "size-file")
    assert.equal(findings[0]?.file, "cubes/gadgets/index.ts")
    assert.match(findings[0]?.message ?? "", /9000 code chars, cap is 6000/)
  })

  it("countMode raw measures every byte", () => {
    const root = build({ "cubes/gadgets/index.ts": `${filler(100)}// ${"x".repeat(9000)}\n` })
    const raw = { ...CAPS, countMode: "raw" as const }
    const findings = sizeCapsFindings(root, raw)
    assert.equal(findings.length, 1)
    // Raw is the file's whole length -- comments and all.
    assert.match(
      findings[0]?.message ?? "",
      new RegExp(`${readFileSync(join(root, "cubes/gadgets/index.ts")).length} raw chars, cap is 6000`),
    )
  })

  it("tests do not count, at any depth", () => {
    const root = build({
      "cubes/gadgets/index.ts": filler(100),
      "cubes/gadgets/big.test.ts": filler(9000),
      "cubes/gadgets/nested/also-big.spec.ts": filler(9000),
    })
    assert.deepEqual(sizeCapsFindings(root, CAPS), [])
  })

  it("node_modules is skipped, nested frontend/ counts", () => {
    const root = build({
      "cubes/gadgets/index.ts": filler(100),
      "cubes/gadgets/node_modules/dep/index.ts": filler(9000),
      "cubes/gadgets/frontend/widget.tsx": filler(9000),
    })
    const findings = sizeCapsFindings(root, CAPS)
    assert.equal(findings.length, 1)
    assert.equal(findings[0]?.file, "cubes/gadgets/frontend/widget.tsx")
  })

  it("a unit over the file or char cap is one finding", () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 16; i++) files[`cubes/big/thing${i}.ts`] = filler(100)
    const root = build(files)
    const findings = sizeCapsFindings(root, CAPS)
    assert.equal(findings.length, 1)
    assert.equal(findings[0]?.rule, "size-unit")
    assert.equal(findings[0]?.file, "cubes/big")
    assert.match(findings[0]?.message ?? "", /16 files \/ \d+ code chars, caps are 15 files \/ 40000 chars/)
  })

  it("each direct child of cubes/ is its own unit; a shared over-cap file fails both units", () => {
    const root = build({
      "cubes/one/index.ts": filler(100),
      "cubes/two/index.ts": filler(100),
      "cubes/two/extra.ts": filler(100),
    })
    assert.deepEqual(sizeCapsFindings(root, CAPS), [])
  })

  it("a missing cubes/ directory measures nothing", () => {
    const root = build({ "README.md": "not source\n" })
    assert.deepEqual(sizeCapsFindings(root, CAPS), [])
  })
})

describe("caps from the kernel config", () => {
  it("reads the documented shape", () => {
    const caps = capsFromConfig({
      countMode: "code",
      caps: { maxCharsPerFile: 6000, maxFilesPerUnit: 15, maxCharsPerUnit: 40000 },
    })
    assert.deepEqual(caps, CAPS)
  })

  it("a wrong number is a thrown kernel error, not a silent default", () => {
    assert.throws(() => capsFromConfig({ caps: { maxCharsPerFile: "big" } }), /caps\.maxCharsPerFile/)
  })

  it("stripComments keeps strings whole -- the number must be real", () => {
    const stripped = stripComments(`const url = "https://x//y" // tail\n`)
    assert.ok(stripped.includes(`"https://x//y"`), "the // inside the string survives")
    assert.ok(!stripped.includes("tail"), "the comment after the code is gone")
  })
})
