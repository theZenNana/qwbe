// Unit tests for the metadata version gate: a cube that declares a `version` may not change
// its schema under the same version. First sight records; a changed hash under the same
// version refuses; a bumped version passes and re-records.

import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, beforeEach, describe, it } from "node:test"
import type { CubeMetadata } from "./schemas.ts"

type Stored = Record<string, { version: string; hash: string }>

const readStored = (): Stored => JSON.parse(readFileSync(join(dataDir, "cube-versions.json"), "utf8")) as Stored

import { checkSchemaDrift, SchemaDriftError } from "./schema-drift.ts"

const meta = (cube: string, version: string | null, hash: string): CubeMetadata => ({
  cube,
  entity: cube,
  list: null,
  version,
  schemaHash: hash,
  fields: [],
})

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "qwb41-drift-"))
  process.env.QWBE_DATA_DIR = dataDir
})

describe("checkSchemaDrift", () => {
  it("records the first sight of a versioned cube without failing", () => {
    checkSchemaDrift([meta("thing", "1.0.0", "aaa")])
    const stored = readStored()
    assert.deepEqual(stored.thing, { version: "1.0.0", hash: "aaa" })
  })

  it("does not track cubes that declare no version", () => {
    checkSchemaDrift([meta("bare", null, "aaa")])
    assert.equal(existsSync(join(dataDir, "cube-versions.json")), false)
  })

  it("passes when the version and the hash are unchanged", () => {
    checkSchemaDrift([meta("thing", "1.0.0", "aaa")])
    checkSchemaDrift([meta("thing", "1.0.0", "aaa")])
  })

  it("refuses a changed schema under the same version", () => {
    checkSchemaDrift([meta("thing", "1.0.0", "aaa")])
    assert.throws(() => checkSchemaDrift([meta("thing", "1.0.0", "bbb")]), SchemaDriftError)
  })

  it("accepts a changed schema when the version was bumped, and re-records", () => {
    checkSchemaDrift([meta("thing", "1.0.0", "aaa")])
    checkSchemaDrift([meta("thing", "1.1.0", "bbb")])
    const stored = readStored()
    assert.deepEqual(stored.thing, { version: "1.1.0", hash: "bbb" })
  })

  it("refuses any hash change under the unchanged current version, even a revert", () => {
    // v1 hash aaa, bump to v2 with hash bbb; going back to aaa under v2 is still a change
    // clients under v2 have not seen -- the gate compares against the CURRENT version only.
    checkSchemaDrift([meta("thing", "1.0.0", "aaa")])
    checkSchemaDrift([meta("thing", "1.1.0", "bbb")])
    assert.throws(() => checkSchemaDrift([meta("thing", "1.1.0", "aaa")]), SchemaDriftError)
  })

  it("keeps records of other cubes while checking one", () => {
    checkSchemaDrift([meta("a", "1.0.0", "aaa"), meta("b", "1.0.0", "bbb")])
    checkSchemaDrift([meta("a", "1.1.0", "xxx")])
    const stored = readStored()
    assert.deepEqual(stored.b, { version: "1.0.0", hash: "bbb" })
  })

  it("compares against the committed baseline on a fresh data directory", () => {
    // A fresh checkout has no data/cube-versions.json; the shipped baseline must still catch
    // a schema that changed under an unchanged version.
    const baseline = mkdtempSync(join(tmpdir(), "qwb41-baseline-"))
    writeFileSync(join(baseline, "cube-versions.json"), JSON.stringify({ thing: { version: "1.0.0", hash: "aaa" } }))
    process.env.QWBE_CUBE_VERSIONS_BASELINE = join(baseline, "cube-versions.json")
    assert.throws(() => checkSchemaDrift([meta("thing", "1.0.0", "bbb")]), SchemaDriftError)
    // A bumped version passes and is recorded in the writable data file, not the baseline.
    checkSchemaDrift([meta("thing", "1.1.0", "bbb")])
    assert.deepEqual(readStored().thing, { version: "1.1.0", hash: "bbb" })
    delete process.env.QWBE_CUBE_VERSIONS_BASELINE
  })

  it("the writable data file wins over the baseline", () => {
    const baseline = mkdtempSync(join(tmpdir(), "qwb41-baseline-"))
    writeFileSync(join(baseline, "cube-versions.json"), JSON.stringify({ thing: { version: "0.9.0", hash: "old" } }))
    process.env.QWBE_CUBE_VERSIONS_BASELINE = join(baseline, "cube-versions.json")
    checkSchemaDrift([meta("thing", "1.0.0", "aaa")])
    // Re-mount: same version and hash, but the baseline names 0.9.0 -- the data record won.
    checkSchemaDrift([meta("thing", "1.0.0", "aaa")])
    delete process.env.QWBE_CUBE_VERSIONS_BASELINE
  })

  it("tolerates a corrupt record file", async () => {
    const { writeFileSync } = await import("node:fs")
    writeFileSync(join(dataDir, "cube-versions.json"), "{not json", "utf8")
    checkSchemaDrift([meta("thing", "1.0.0", "aaa")])
  })
})

after(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})
