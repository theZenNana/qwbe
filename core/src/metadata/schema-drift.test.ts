// Unit tests for the metadata version gate: a cube that declares a `version` may not change
// its schema under the same version. First sight records; a changed hash under the same
// version refuses; a bumped version passes and re-records.

import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeContext } from "@effect/platform-node"
import { Effect, Either } from "effect"
import { afterAll, beforeEach, describe, it } from "vitest"
import { testConfigLayer } from "../test-config.ts"
import type { CubeMetadata } from "./schemas.ts"

type Stored = Record<string, { version: string; hash: string }>

const readStored = (): Stored => JSON.parse(readFileSync(join(dataDir, "cube-versions.json"), "utf8")) as Stored

import { CubeVersionsCorruptError, checkSchemaDrift as check, SchemaDriftError } from "./schema-drift.ts"

let baselineFile: string | undefined

/** Runs the gate over the test's data directory; a typed failure is thrown so asserts read as before. */
const checkSchemaDrift = async (metadata: ReadonlyArray<CubeMetadata>) => {
  const env: Record<string, string> = { QWBE_DATA_DIR: dataDir }
  if (baselineFile) env.QWBE_CUBE_VERSIONS_BASELINE = baselineFile
  const result = await Effect.runPromise(
    Effect.either(check(metadata).pipe(Effect.provide(testConfigLayer(env)), Effect.provide(NodeContext.layer))),
  )
  if (Either.isLeft(result)) throw result.left
}

const meta = (cube: string, version: string | null, hash: string): CubeMetadata => ({
  cube,
  entity: cube,
  list: null,
  version,
  schemaHash: hash,
  routes: {},
  fields: [],
})

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "qwb41-drift-"))
  baselineFile = undefined
})

describe("checkSchemaDrift", () => {
  it("records the first sight of a versioned cube without failing", async () => {
    await checkSchemaDrift([meta("thing", "1.0.0", "aaa")])
    const stored = readStored()
    assert.deepEqual(stored.thing, { version: "1.0.0", hash: "aaa" })
  })

  it("does not track cubes that declare no version", async () => {
    await checkSchemaDrift([meta("bare", null, "aaa")])
    assert.equal(existsSync(join(dataDir, "cube-versions.json")), false)
  })

  it("passes when the version and the hash are unchanged", async () => {
    await checkSchemaDrift([meta("thing", "1.0.0", "aaa")])
    await checkSchemaDrift([meta("thing", "1.0.0", "aaa")])
  })

  it("refuses a changed schema under the same version", async () => {
    await checkSchemaDrift([meta("thing", "1.0.0", "aaa")])
    await assert.rejects(() => checkSchemaDrift([meta("thing", "1.0.0", "bbb")]), SchemaDriftError)
  })

  it("accepts a changed schema when the version was bumped, and re-records", async () => {
    await checkSchemaDrift([meta("thing", "1.0.0", "aaa")])
    await checkSchemaDrift([meta("thing", "1.1.0", "bbb")])
    const stored = readStored()
    assert.deepEqual(stored.thing, { version: "1.1.0", hash: "bbb" })
  })

  it("refuses any hash change under the unchanged current version, even a revert", async () => {
    // v1 hash aaa, bump to v2 with hash bbb; going back to aaa under v2 is still a change
    // clients under v2 have not seen -- the gate compares against the CURRENT version only.
    await checkSchemaDrift([meta("thing", "1.0.0", "aaa")])
    await checkSchemaDrift([meta("thing", "1.1.0", "bbb")])
    await assert.rejects(() => checkSchemaDrift([meta("thing", "1.1.0", "aaa")]), SchemaDriftError)
  })

  it("keeps records of other cubes while checking one", async () => {
    await checkSchemaDrift([meta("a", "1.0.0", "aaa"), meta("b", "1.0.0", "bbb")])
    await checkSchemaDrift([meta("a", "1.1.0", "xxx")])
    const stored = readStored()
    assert.deepEqual(stored.b, { version: "1.0.0", hash: "bbb" })
  })

  it("compares against the committed baseline on a fresh data directory", async () => {
    // A fresh checkout has no data/cube-versions.json; the shipped baseline must still catch
    // a schema that changed under an unchanged version.
    const baseline = mkdtempSync(join(tmpdir(), "qwb41-baseline-"))
    writeFileSync(join(baseline, "cube-versions.json"), JSON.stringify({ thing: { version: "1.0.0", hash: "aaa" } }))
    baselineFile = join(baseline, "cube-versions.json")
    await assert.rejects(() => checkSchemaDrift([meta("thing", "1.0.0", "bbb")]), SchemaDriftError)
    // A bumped version passes and is recorded in the writable data file, not the baseline.
    await checkSchemaDrift([meta("thing", "1.1.0", "bbb")])
    assert.deepEqual(readStored().thing, { version: "1.1.0", hash: "bbb" })
  })

  it("the writable data file wins over the baseline", async () => {
    const baseline = mkdtempSync(join(tmpdir(), "qwb41-baseline-"))
    writeFileSync(join(baseline, "cube-versions.json"), JSON.stringify({ thing: { version: "0.9.0", hash: "old" } }))
    baselineFile = join(baseline, "cube-versions.json")
    await checkSchemaDrift([meta("thing", "1.0.0", "aaa")])
    // Re-mount: same version and hash, but the baseline names 0.9.0 -- the data record won.
    await checkSchemaDrift([meta("thing", "1.0.0", "aaa")])
  })

  it("refuses a corrupt record file as a typed failure, never an empty record", async () => {
    writeFileSync(join(dataDir, "cube-versions.json"), "{not json", "utf8")
    await assert.rejects(() => checkSchemaDrift([meta("thing", "1.0.0", "aaa")]), CubeVersionsCorruptError)
    // The corrupt file is left as it was for the operator to repair.
    assert.equal(readFileSync(join(dataDir, "cube-versions.json"), "utf8"), "{not json")
  })
})

afterAll(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})
