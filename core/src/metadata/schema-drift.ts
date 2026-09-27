// The version gate for derived metadata.
//
// A frontend caches metadata keyed by the cube's declared `version`. If a field changes while
// the version stays put, cached clients keep drawing forms for a schema that no longer exists
// -- silently, the worst way. So the mount records each tracked cube's (version, schemaHash);
// on the next mount, the same version with a different hash is a life rule failure and the
// server does not start.
//
// Deliberately tracked only for cubes that DECLARE a `version` in their manifest: a cube that
// promises nothing cannot break a promise, and existing cubes keep mounting untouched. Bumping
// the version is the visible, one-line fix.

import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { FileSystem } from "@effect/platform"
import { Data, Effect, Schema } from "effect"
import { QwbeConfig } from "../config.ts"
import type { CubeMetadata } from "./schemas.ts"

const here = dirname(fileURLToPath(import.meta.url))
// The COMMITTED baseline: without it, a fresh checkout or CI has no records to compare
// against and the first thing to catch a missing version bump would be a customer's server
// refusing to boot after an upgrade. The baseline ships with the cubes it describes, so the
// gates see the drift instead of the restart. The writable data file (per-machine records,
// updated on every mount) wins over it.
const defaultBaseline = join(here, "cube-versions.baseline.json")

export class SchemaDriftError extends Data.TaggedError("SchemaDriftError")<{ readonly message: string }> {
  constructor(cube: string, version: string, expected: string, got: string) {
    super({
      message:
        `Cube "${cube}" declares version ${version} but its schema changed: recorded ${expected}, now ${got}. ` +
        `A field changed without the version being bumped -- clients caching metadata under ` +
        `version ${version} would keep building forms for a schema that no longer exists. ` +
        `Bump \`version\` in the cube's manifest.`,
    })
  }
}

/** A version record file that is there but does not decode. Never read as "nothing recorded":
 *  an empty record would let a changed schema through under its old version. */
export class CubeVersionsCorruptError extends Data.TaggedError("CubeVersionsCorruptError")<{
  readonly path: string
  readonly message: string
}> {}

const Records = Schema.parseJson(
  Schema.Record({ key: Schema.String, value: Schema.Struct({ version: Schema.String, hash: Schema.String }) }),
)
type Records = typeof Records.Type

const readOne = (fs: FileSystem.FileSystem, file: string) =>
  Effect.gen(function* () {
    if (!(yield* fs.exists(file))) return {}
    return yield* Schema.decodeUnknown(Records)(yield* fs.readFileString(file)).pipe(
      Effect.mapError((e) => new CubeVersionsCorruptError({ path: file, message: `${file} is corrupt: ${e.message}` })),
    )
  })

/**
 * Check every cube that declares a `version`, then record the fresh state.
 *
 * Runs at mount, after metadata is derived: first mount of a cube only records; a later mount
 * with the same version and a different hash refuses to start. A first-seen cube (or a first
 * run after this rule landed) is recorded, never refused -- there is nothing to compare with.
 */
export const checkSchemaDrift = (metadata: ReadonlyArray<CubeMetadata>) =>
  Effect.gen(function* () {
    const tracked = metadata.filter((m) => m.version !== null)
    if (tracked.length === 0) return
    const fs = yield* FileSystem.FileSystem
    const { dataDir, cubeVersionsBaseline } = yield* QwbeConfig
    const versionsFile = join(dataDir, "cube-versions.json")
    const records: Records = {
      ...(yield* readOne(fs, cubeVersionsBaseline ?? defaultBaseline)),
      ...(yield* readOne(fs, versionsFile)),
    }
    for (const m of tracked) {
      const prev = records[m.cube]
      if (prev && prev.version === m.version && prev.hash !== m.schemaHash) {
        return yield* new SchemaDriftError(m.cube, m.version, prev.hash, m.schemaHash)
      }
    }
    const fresh: Record<string, { version: string; hash: string }> = { ...records }
    for (const m of tracked) fresh[m.cube] = { version: m.version!, hash: m.schemaHash }
    const sorted = Object.fromEntries(Object.entries(fresh).sort(([a], [b]) => a.localeCompare(b)))
    yield* fs.makeDirectory(dataDir, { recursive: true })
    yield* fs.writeFileString(versionsFile, `${JSON.stringify(sorted, null, 2)}\n`)
  })
