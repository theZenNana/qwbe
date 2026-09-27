// Unit tests for store-drift (QWB-54 ticket 22): the shelf/provenance/source triangle, judged
// on temp fixtures. The drift check hashes bytes, it does not judge package contracts, so a
// minimal tree is enough to stand for a real package.

import assert from "node:assert/strict"
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { NodeContext } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Context, Effect, Layer } from "effect"
import { packageSourceFingerprint as fingerprint, PROVENANCE } from "./package-source.ts"
import { shelfDrift as drift, storeDrift as driftAll } from "./store-drift.ts"
import { tempDir } from "./test-fixture-pack.ts"

const STAGED_AT = "2026-09-01T00:00:00.000Z"
const writeSource = (source: string, body: string) => writeFileSync(join(source, "cubes", "note", "index.ts"), body)

/** One bench for the file: the last test reads the shelves the others staged. Removed with the file's scope. */
class Bench extends Context.Tag("Bench")<Bench, { readonly bench: string; readonly source: string }>() {}
const BenchLive = Layer.scoped(
  Bench,
  Effect.map(tempDir("qwbe-store-drift-"), (bench) => {
    const source = join(bench, "source")
    mkdirSync(join(source, "cubes", "note"), { recursive: true })
    writeSource(source, "export const note = 1\n")
    return { bench, source }
  }),
).pipe(Layer.provideMerge(NodeContext.layer))

/** A shelf copied from the source, carrying real provenance - what staging leaves behind. */
const stage = (name: string) =>
  Effect.gen(function* () {
    const { bench, source } = yield* Bench
    const shelf = join(bench, "store", name)
    cpSync(source, shelf, { recursive: true })
    const stamp = { sourcePath: source, fingerprint: yield* fingerprint(source), stagedAt: STAGED_AT }
    writeFileSync(join(shelf, PROVENANCE), `${JSON.stringify(stamp, null, 2)}\n`)
    return shelf
  })

layer(BenchLive)("shelf drift against its provenance", (it) => {
  it.effect("a shelf identical to its source is ok", () =>
    Effect.gen(function* () {
      const { source } = yield* Bench
      assert.deepEqual(yield* drift(yield* stage("fresh"), "fresh"), {
        name: "fresh",
        status: "ok",
        sourcePath: source,
        stagedAt: STAGED_AT,
      })
    }),
  )

  it.effect("a source that moved on leaves the copy behind - drifted", () =>
    Effect.gen(function* () {
      const { source } = yield* Bench
      const shelf = yield* stage("behind")
      writeSource(source, "export const note = 2\n")
      const verdict = yield* drift(shelf, "behind")
      assert.equal(verdict.status, "drifted")
      assert.match(verdict.detail, /source changed after staging/)
      writeSource(source, "export const note = 1\n")
    }),
  )

  it.effect("an edited shelf is drifted even when the source stands still", () =>
    Effect.gen(function* () {
      const shelf = yield* stage("edited")
      writeFileSync(join(shelf, "cubes", "note", "extra.ts"), "export const extra = 1\n")
      const verdict = yield* drift(shelf, "edited")
      assert.equal(verdict.status, "drifted")
      assert.match(verdict.detail, /store copy was changed after staging/)
    }),
  )

  it.effect("a shelf that grew a node_modules is drifted: staging never writes tooling into a shelf", () =>
    Effect.gen(function* () {
      // The shelf hash skips nothing but the provenance file. Authoring tool state (node_modules,
      // dot-directories, a package.json) on a shelf is by definition a manual change -- it can
      // shadow the kernel's own resolution once installed -- so it must answer as drift, not
      // vanish under the source-checkout rule.
      const shelf = yield* stage("poisoned")
      mkdirSync(join(shelf, "node_modules", "shadow"), { recursive: true })
      writeFileSync(join(shelf, "node_modules", "shadow", "index.js"), "module.exports = 1\n")
      const verdict = yield* drift(shelf, "poisoned")
      assert.equal(verdict.status, "drifted")
      assert.match(verdict.detail, /store copy was changed after staging/)
    }),
  )

  it.effect("a shelf without provenance is red, not silently trusted", () =>
    Effect.gen(function* () {
      const shelf = yield* stage("anonymous")
      rmSync(join(shelf, PROVENANCE))
      const verdict = yield* drift(shelf, "anonymous")
      assert.equal(verdict.status, "no-provenance")
      assert.match(verdict.detail, /staged by hand/)
    }),
  )

  it.effect("a missing source cannot prove freshness - red", () =>
    Effect.gen(function* () {
      const { bench } = yield* Bench
      const lone = join(bench, "lone")
      mkdirSync(lone, { recursive: true })
      writeFileSync(join(lone, "a.ts"), "export const a = 1\n")
      const shelf = join(bench, "store", "orphan")
      cpSync(lone, shelf, { recursive: true })
      writeFileSync(
        join(shelf, PROVENANCE),
        `${JSON.stringify(
          { sourcePath: join(bench, "vanished"), fingerprint: yield* fingerprint(lone), stagedAt: STAGED_AT },
          null,
          2,
        )}\n`,
      )
      const verdict = yield* drift(shelf, "orphan")
      assert.equal(verdict.status, "source-missing")
    }),
  )

  it.effect("the store view lists every shelf by name and skips hidden staging directories", () =>
    Effect.gen(function* () {
      const { bench } = yield* Bench
      mkdirSync(join(bench, "store", ".staging-x"), { recursive: true })
      const verdicts = yield* driftAll(join(bench, "store"))
      const byName = new Map(verdicts.map((v) => [v.name, v.status]))
      assert.equal(byName.get("fresh"), "ok")
      assert.equal(byName.get("edited"), "drifted")
      assert.equal(byName.get("anonymous"), "no-provenance")
      assert.equal(byName.get("orphan"), "source-missing")
      assert.equal(byName.has(".staging-x"), false)
    }),
  )
})
