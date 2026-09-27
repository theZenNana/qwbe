// Unit tests for the pack-facing size measuring (`qwbe check` stage 2).
//
// The fixtures live in a temp directory: the rules judge whatever tree they are pointed at, and
// a rule that needs an OVER-CAP file cannot ship inside the tree the kernel's own gate walks.

import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { NodeContext } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"

import { capsFromConfig, sizeCapsFindings, stripComments } from "./package-size.ts"
import { tempDir } from "./test-fixture-pack.ts"

const CAPS = { countMode: "code" as const, maxCharsPerFile: 6000, maxFilesPerUnit: 15, maxCharsPerUnit: 40000 }

const build = (files: Record<string, string>) =>
  Effect.map(tempDir("qwbe-package-size-"), (root) => {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(root, rel, ".."), { recursive: true })
      writeFileSync(join(root, rel), body)
    }
    return root
  })

const env = layer(NodeContext.layer)

const filler = (code: number) => `const x = "${"a".repeat(Math.max(0, code - 12))}"\n`

env("size caps for a package", (it) => {
  it.scoped("a package under every cap passes", () =>
    Effect.gen(function* () {
      const root = yield* build({ "cubes/gadgets/index.ts": filler(100) })
      assert.deepEqual(yield* sizeCapsFindings(root, CAPS), [])
    }),
  )

  it.scoped("a file over the code cap is a finding, and comments do not count", () =>
    Effect.gen(function* () {
      const root = yield* build({
        // 9000 code chars + 9000 chars of comment: over the cap by CODE, and the comment adds nothing.
        "cubes/gadgets/index.ts": `${filler(9000)}// ${"x".repeat(9000)}\n`,
      })
      const findings = yield* sizeCapsFindings(root, CAPS)
      assert.equal(findings.length, 1)
      assert.equal(findings[0]?.rule, "size-file")
      assert.equal(findings[0]?.file, "cubes/gadgets/index.ts")
      assert.match(findings[0]?.message ?? "", /9000 code chars, cap is 6000/)
    }),
  )

  it.scoped("countMode raw measures every byte", () =>
    Effect.gen(function* () {
      const root = yield* build({ "cubes/gadgets/index.ts": `${filler(100)}// ${"x".repeat(9000)}\n` })
      const raw = { ...CAPS, countMode: "raw" as const }
      const findings = yield* sizeCapsFindings(root, raw)
      assert.equal(findings.length, 1)
      // Raw is the file's whole length -- comments and all.
      assert.match(
        findings[0]?.message ?? "",
        new RegExp(`${readFileSync(join(root, "cubes/gadgets/index.ts")).length} raw chars, cap is 6000`),
      )
    }),
  )

  it.scoped("tests do not count, at any depth", () =>
    Effect.gen(function* () {
      const root = yield* build({
        "cubes/gadgets/index.ts": filler(100),
        "cubes/gadgets/big.test.ts": filler(9000),
        "cubes/gadgets/nested/also-big.spec.ts": filler(9000),
      })
      assert.deepEqual(yield* sizeCapsFindings(root, CAPS), [])
    }),
  )

  it.scoped("node_modules is skipped, nested frontend/ counts", () =>
    Effect.gen(function* () {
      const root = yield* build({
        "cubes/gadgets/index.ts": filler(100),
        "cubes/gadgets/node_modules/dep/index.ts": filler(9000),
        "cubes/gadgets/frontend/widget.tsx": filler(9000),
      })
      const findings = yield* sizeCapsFindings(root, CAPS)
      assert.equal(findings.length, 1)
      assert.equal(findings[0]?.file, "cubes/gadgets/frontend/widget.tsx")
    }),
  )

  it.scoped("a unit over the file or char cap is one finding", () =>
    Effect.gen(function* () {
      const files: Record<string, string> = {}
      for (let i = 0; i < 16; i++) files[`cubes/big/thing${i}.ts`] = filler(100)
      const root = yield* build(files)
      const findings = yield* sizeCapsFindings(root, CAPS)
      assert.equal(findings.length, 1)
      assert.equal(findings[0]?.rule, "size-unit")
      assert.equal(findings[0]?.file, "cubes/big")
      assert.match(findings[0]?.message ?? "", /16 files \/ \d+ code chars, caps are 15 files \/ 40000 chars/)
    }),
  )

  it.scoped("each direct child of cubes/ is its own unit; a shared over-cap file fails both units", () =>
    Effect.gen(function* () {
      const root = yield* build({
        "cubes/one/index.ts": filler(100),
        "cubes/two/index.ts": filler(100),
        "cubes/two/extra.ts": filler(100),
      })
      assert.deepEqual(yield* sizeCapsFindings(root, CAPS), [])
    }),
  )

  it.scoped("a missing cubes/ directory measures nothing", () =>
    Effect.gen(function* () {
      const root = yield* build({ "README.md": "not source\n" })
      assert.deepEqual(yield* sizeCapsFindings(root, CAPS), [])
    }),
  )
})

env("caps from the kernel config", (it) => {
  it.scoped("reads the documented shape", () =>
    Effect.gen(function* () {
      const caps = yield* capsFromConfig({
        countMode: "code",
        caps: { maxCharsPerFile: 6000, maxFilesPerUnit: 15, maxCharsPerUnit: 40000 },
      })
      assert.deepEqual(caps, CAPS)
    }),
  )

  it.scoped("a wrong number is a kernel error naming the key, not a silent default", () =>
    Effect.gen(function* () {
      assert.match(
        (yield* Effect.flip(capsFromConfig({ caps: { maxCharsPerFile: "big" } }))).message,
        /maxCharsPerFile/,
      )
    }),
  )

  it("stripComments keeps strings whole -- the number must be real", () => {
    const stripped = stripComments(`const url = "https://x//y" // tail\n`)
    assert.ok(stripped.includes(`"https://x//y"`), "the // inside the string survives")
    assert.ok(!stripped.includes("tail"), "the comment after the code is gone")
  })
})
