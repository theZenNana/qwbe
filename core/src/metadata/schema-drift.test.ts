// Unit tests for the metadata version gate: a cube that declares a `version` may not change
// its schema under the same version. First sight records; a changed hash under the same
// version refuses; a bumped version passes and re-records.

import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { FileSystem } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { testConfigLayer } from "../test-config.ts"
import { CubeVersionsCorruptError, checkSchemaDrift as check, SchemaDriftError } from "./schema-drift.ts"
import type { CubeMetadata } from "./schemas.ts"

type Stored = Record<string, { version: string; hash: string }>

const readStored = (dataDir: string): Stored =>
  JSON.parse(readFileSync(join(dataDir, "cube-versions.json"), "utf8")) as Stored

/** A directory removed when the test's scope closes, even on failure. */
const tempDir = (prefix: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectoryScoped({ prefix }))

/** The gate over one data directory (and an optional committed baseline). */
const gateOn = (dataDir: string, baselineFile?: string) => (metadata: ReadonlyArray<CubeMetadata>) => {
  const env: Record<string, string> = { QWBE_DATA_DIR: dataDir }
  if (baselineFile) env.QWBE_CUBE_VERSIONS_BASELINE = baselineFile
  return check(metadata).pipe(Effect.provide(testConfigLayer(env)))
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

/** A fresh data directory per test and the gate over it. */
const fresh = Effect.map(tempDir("qwb41-drift-"), (dataDir) => ({ dataDir, checkSchemaDrift: gateOn(dataDir) }))

layer(NodeContext.layer)("checkSchemaDrift", (it) => {
  it.scoped("records the first sight of a versioned cube without failing", () =>
    Effect.gen(function* () {
      const { dataDir, checkSchemaDrift } = yield* fresh
      yield* checkSchemaDrift([meta("thing", "1.0.0", "aaa")])
      const stored = readStored(dataDir)
      assert.deepEqual(stored.thing, { version: "1.0.0", hash: "aaa" })
    }),
  )

  it.scoped("does not track cubes that declare no version", () =>
    Effect.gen(function* () {
      const { dataDir, checkSchemaDrift } = yield* fresh
      yield* checkSchemaDrift([meta("bare", null, "aaa")])
      assert.equal(existsSync(join(dataDir, "cube-versions.json")), false)
    }),
  )

  it.scoped("passes when the version and the hash are unchanged", () =>
    Effect.gen(function* () {
      const { checkSchemaDrift } = yield* fresh
      yield* checkSchemaDrift([meta("thing", "1.0.0", "aaa")])
      yield* checkSchemaDrift([meta("thing", "1.0.0", "aaa")])
    }),
  )

  it.scoped("refuses a changed schema under the same version", () =>
    Effect.gen(function* () {
      const { checkSchemaDrift } = yield* fresh
      yield* checkSchemaDrift([meta("thing", "1.0.0", "aaa")])
      assert.ok((yield* Effect.flip(checkSchemaDrift([meta("thing", "1.0.0", "bbb")]))) instanceof SchemaDriftError)
    }),
  )

  it.scoped("accepts a changed schema when the version was bumped, and re-records", () =>
    Effect.gen(function* () {
      const { dataDir, checkSchemaDrift } = yield* fresh
      yield* checkSchemaDrift([meta("thing", "1.0.0", "aaa")])
      yield* checkSchemaDrift([meta("thing", "1.1.0", "bbb")])
      const stored = readStored(dataDir)
      assert.deepEqual(stored.thing, { version: "1.1.0", hash: "bbb" })
    }),
  )

  it.scoped("refuses any hash change under the unchanged current version, even a revert", () =>
    Effect.gen(function* () {
      const { checkSchemaDrift } = yield* fresh
      // v1 hash aaa, bump to v2 with hash bbb; going back to aaa under v2 is still a change
      // clients under v2 have not seen -- the gate compares against the CURRENT version only.
      yield* checkSchemaDrift([meta("thing", "1.0.0", "aaa")])
      yield* checkSchemaDrift([meta("thing", "1.1.0", "bbb")])
      assert.ok((yield* Effect.flip(checkSchemaDrift([meta("thing", "1.1.0", "aaa")]))) instanceof SchemaDriftError)
    }),
  )

  it.scoped("keeps records of other cubes while checking one", () =>
    Effect.gen(function* () {
      const { dataDir, checkSchemaDrift } = yield* fresh
      yield* checkSchemaDrift([meta("a", "1.0.0", "aaa"), meta("b", "1.0.0", "bbb")])
      yield* checkSchemaDrift([meta("a", "1.1.0", "xxx")])
      const stored = readStored(dataDir)
      assert.deepEqual(stored.b, { version: "1.0.0", hash: "bbb" })
    }),
  )

  it.scoped("compares against the committed baseline on a fresh data directory", () =>
    Effect.gen(function* () {
      const { dataDir } = yield* fresh
      // A fresh checkout has no data/cube-versions.json; the shipped baseline must still catch
      // a schema that changed under an unchanged version.
      const baseline = yield* tempDir("qwb41-baseline-")
      writeFileSync(join(baseline, "cube-versions.json"), JSON.stringify({ thing: { version: "1.0.0", hash: "aaa" } }))
      const checkSchemaDrift = gateOn(dataDir, join(baseline, "cube-versions.json"))
      assert.ok((yield* Effect.flip(checkSchemaDrift([meta("thing", "1.0.0", "bbb")]))) instanceof SchemaDriftError)
      // A bumped version passes and is recorded in the writable data file, not the baseline.
      yield* checkSchemaDrift([meta("thing", "1.1.0", "bbb")])
      assert.deepEqual(readStored(dataDir).thing, { version: "1.1.0", hash: "bbb" })
    }),
  )

  it.scoped("the writable data file wins over the baseline", () =>
    Effect.gen(function* () {
      const { dataDir } = yield* fresh
      const baseline = yield* tempDir("qwb41-baseline-")
      writeFileSync(join(baseline, "cube-versions.json"), JSON.stringify({ thing: { version: "0.9.0", hash: "old" } }))
      const checkSchemaDrift = gateOn(dataDir, join(baseline, "cube-versions.json"))
      yield* checkSchemaDrift([meta("thing", "1.0.0", "aaa")])
      // Re-mount: same version and hash, but the baseline names 0.9.0 -- the data record won.
      yield* checkSchemaDrift([meta("thing", "1.0.0", "aaa")])
    }),
  )

  it.scoped("refuses a corrupt record file as a typed failure, never an empty record", () =>
    Effect.gen(function* () {
      const { dataDir, checkSchemaDrift } = yield* fresh
      writeFileSync(join(dataDir, "cube-versions.json"), "{not json", "utf8")
      assert.ok(
        (yield* Effect.flip(checkSchemaDrift([meta("thing", "1.0.0", "aaa")]))) instanceof CubeVersionsCorruptError,
      )
      // The corrupt file is left as it was for the operator to repair.
      assert.equal(readFileSync(join(dataDir, "cube-versions.json"), "utf8"), "{not json")
    }),
  )
})
