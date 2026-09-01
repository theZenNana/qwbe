// Unit tests for store-drift (QWB-54 ticket 22): the shelf/provenance/source triangle, judged
// on temp fixtures. The drift check hashes bytes, it does not judge package contracts, so a
// minimal tree is enough to stand for a real package.

import assert from "node:assert/strict"
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { PROVENANCE, packageSourceFingerprint } from "./package-source.ts"
import { shelfDrift, storeDrift } from "./store-drift.ts"

const bench = mkdtempSync(join(tmpdir(), "qwbe-store-drift-"))
after(() => rmSync(bench, { recursive: true, force: true }))

const STAGED_AT = "2026-09-01T00:00:00.000Z"
const source = join(bench, "source")
mkdirSync(join(source, "cubes", "note"), { recursive: true })
const writeSource = (body: string) => writeFileSync(join(source, "cubes", "note", "index.ts"), body)
writeSource("export const note = 1\n")

/** A shelf copied from the source, carrying real provenance - what staging leaves behind. */
const stage = (name: string, sourcePath = source): string => {
  const shelf = join(bench, "store", name)
  cpSync(source, shelf, { recursive: true })
  writeFileSync(
    join(shelf, PROVENANCE),
    `${JSON.stringify({ sourcePath, fingerprint: packageSourceFingerprint(sourcePath), stagedAt: STAGED_AT }, null, 2)}\n`,
  )
  return shelf
}

describe("shelf drift against its provenance", () => {
  it("a shelf identical to its source is ok", () => {
    assert.deepEqual(shelfDrift(stage("fresh"), "fresh"), {
      name: "fresh",
      status: "ok",
      sourcePath: source,
      stagedAt: STAGED_AT,
    })
  })

  it("a source that moved on leaves the copy behind - drifted", () => {
    const shelf = stage("behind")
    writeSource("export const note = 2\n")
    const verdict = shelfDrift(shelf, "behind")
    assert.equal(verdict.status, "drifted")
    assert.match(verdict.detail, /source changed after staging/)
    writeSource("export const note = 1\n")
  })

  it("an edited shelf is drifted even when the source stands still", () => {
    const shelf = stage("edited")
    writeFileSync(join(shelf, "cubes", "note", "extra.ts"), "export const extra = 1\n")
    const verdict = shelfDrift(shelf, "edited")
    assert.equal(verdict.status, "drifted")
    assert.match(verdict.detail, /store copy was changed after staging/)
  })

  it("a shelf that grew a node_modules is drifted: staging never writes tooling into a shelf", () => {
    // The shelf hash skips nothing but the provenance file. Authoring tool state (node_modules,
    // dot-directories, a package.json) on a shelf is by definition a manual change -- it can
    // shadow the kernel's own resolution once installed -- so it must answer as drift, not
    // vanish under the source-checkout rule.
    const shelf = stage("poisoned")
    mkdirSync(join(shelf, "node_modules", "shadow"), { recursive: true })
    writeFileSync(join(shelf, "node_modules", "shadow", "index.js"), "module.exports = 1\n")
    const verdict = shelfDrift(shelf, "poisoned")
    assert.equal(verdict.status, "drifted")
    assert.match(verdict.detail, /store copy was changed after staging/)
  })

  it("a shelf without provenance is red, not silently trusted", () => {
    const shelf = stage("anonymous")
    rmSync(join(shelf, PROVENANCE))
    const verdict = shelfDrift(shelf, "anonymous")
    assert.equal(verdict.status, "no-provenance")
    assert.match(verdict.detail, /staged by hand/)
  })

  it("a missing source cannot prove freshness - red", () => {
    const lone = join(bench, "lone")
    mkdirSync(lone, { recursive: true })
    writeFileSync(join(lone, "a.ts"), "export const a = 1\n")
    const shelf = join(bench, "store", "orphan")
    cpSync(lone, shelf, { recursive: true })
    writeFileSync(
      join(shelf, PROVENANCE),
      `${JSON.stringify(
        { sourcePath: join(bench, "vanished"), fingerprint: packageSourceFingerprint(lone), stagedAt: STAGED_AT },
        null,
        2,
      )}\n`,
    )
    const verdict = shelfDrift(shelf, "orphan")
    assert.equal(verdict.status, "source-missing")
  })

  it("the store view lists every shelf by name and skips hidden staging directories", () => {
    mkdirSync(join(bench, "store", ".staging-x"), { recursive: true })
    const verdicts = storeDrift(join(bench, "store"))
    const byName = new Map(verdicts.map((v) => [v.name, v.status]))
    assert.equal(byName.get("fresh"), "ok")
    assert.equal(byName.get("edited"), "drifted")
    assert.equal(byName.get("anonymous"), "no-provenance")
    assert.equal(byName.get("orphan"), "source-missing")
    assert.equal(byName.has(".staging-x"), false)
  })
})
