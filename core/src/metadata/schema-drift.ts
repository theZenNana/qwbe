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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { CubeMetadata } from "./schemas.ts"

const here = dirname(fileURLToPath(import.meta.url))
// Read lazily: the environment must win at CALL time, not at import time -- unit tests point
// this at a scratch directory and the value has to be honoured.
const dataDir = () => process.env.QWBE_DATA_DIR ?? join(here, "..", "..", "..", "data")
const versionsFile = () => join(dataDir(), "cube-versions.json")
// The COMMITTED baseline: without it, a fresh checkout or CI has no records to compare
// against and the first thing to catch a missing version bump would be a customer's server
// refusing to boot after an upgrade. The baseline ships with the cubes it describes, so the
// gates see the drift instead of the restart. The writable data file (per-machine records,
// updated on every mount) wins over it.
const baselineFile = () => process.env.QWBE_CUBE_VERSIONS_BASELINE ?? join(here, "cube-versions.baseline.json")

export class SchemaDriftError extends Error {
  constructor(cube: string, version: string, expected: string, got: string) {
    super(
      `Cube "${cube}" declares version ${version} but its schema changed: recorded ${expected}, now ${got}. ` +
        `A field changed without the version being bumped -- clients caching metadata under ` +
        `version ${version} would keep building forms for a schema that no longer exists. ` +
        `Bump \`version\` in the cube's manifest.`,
    )
    this.name = "SchemaDriftError"
  }
}

type Records = Record<string, { readonly version: string; readonly hash: string }>

const readOne = (file: string): Records => {
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Records
  } catch {
    return {}
  }
}

const readRecords = (): Records => ({ ...readOne(baselineFile()), ...readOne(versionsFile()) })

const writeRecords = (records: Records): void => {
  const dir = dataDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const sorted = Object.fromEntries(Object.entries(records).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(versionsFile(), `${JSON.stringify(sorted, null, 2)}\n`, "utf8")
}

/**
 * Check every cube that declares a `version`, then record the fresh state.
 *
 * Runs at mount, after metadata is derived: first mount of a cube only records; a later mount
 * with the same version and a different hash refuses to start. A first-seen cube (or a first
 * run after this rule landed) is recorded, never refused -- there is nothing to compare with.
 */
export const checkSchemaDrift = (metadata: ReadonlyArray<CubeMetadata>): void => {
  const tracked = metadata.filter((m) => m.version !== null)
  if (tracked.length === 0) return
  const records = readRecords()
  for (const m of tracked) {
    const prev = records[m.cube]
    if (prev && prev.version === m.version && prev.hash !== m.schemaHash) {
      throw new SchemaDriftError(m.cube, m.version, prev.hash, m.schemaHash)
    }
  }
  const fresh: Records = { ...records }
  for (const m of tracked) fresh[m.cube] = { version: m.version!, hash: m.schemaHash }
  writeRecords(fresh)
}
