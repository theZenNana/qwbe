// Data migrations between store files, DECLARED by packages and executed by the kernel.
//
// Split out of discovery.ts on 2026-08-11 when the hierarchy work pushed that file past its
// size cap. Rewritten the same day after review: no list of cube names lives here any more --
// a migration is a `dataMigration` entry in a package's manifest, checked at mount against the
// mounted set and the package's provenance.
//
// The rules that keep a plugin from reaching outside itself:
//   - `toCube` must be a mounted cube of the declaring package;
//   - `fromCube` is a bare name whose file sits in the data directory -- the kernel derives the
//     path, a manifest can never name one;
//   - preflight runs for EVERY migration and EVERY companion file (.sqlite, -wal, -shm) before
//     a single byte moves;
//   - a failed move rolls the whole batch back.

import { existsSync, renameSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type DataMigration, storeFileName } from "./manifest.ts"

export { MigrationOwnershipError } from "./migrate-ownership.ts"

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = process.env.QWBE_DATA_DIR ?? join(here, "..", "..", "..", "data")

export class MigrationConflictError extends Error {
  constructor(from: string, to: string) {
    super(
      `Data migration refused: both "${from}" and "${to}" exist in the data directory. ` +
        `One of them must be removed by hand -- choosing one silently would be choosing which ` +
        `data to lose.`,
    )
    this.name = "MigrationConflictError"
  }
}

export class MigrationFailedError extends Error {
  constructor(from: string, to: string, cause: string, rollbackFailed: boolean) {
    super(
      rollbackFailed
        ? `Data migration failed moving "${from}" to "${to}": ${cause}. ` +
            `The rollback ALSO failed for at least one file (logged above) -- the data directory ` +
            `may hold a partial batch. Inspect it before restarting.`
        : `Data migration failed moving "${from}" to "${to}" and the batch was rolled back: ${cause}`,
    )
    this.name = "MigrationFailedError"
  }
}

type Move = { readonly fromPath: string; readonly toPath: string }

/** The three files that travel together: the database and its WAL companions. */
const companions = (base: string): ReadonlyArray<string> =>
  [base, `${base}-wal`, `${base}-shm`].filter((p) => existsSync(p))

/**
 * Plan, preflight, move, rollback.
 *
 * Preflight is a SEPARATE pass over the entire batch: every source must exist and every
 * destination must not, for every companion of every migration. Only when the whole plan is
 * clean does the first rename run. A rename that still throws rolls back what has moved.
 *
 * `rename` is a parameter, not an import: the production caller passes `renameSync`, a probe
 * passes a function that throws at a chosen move -- no environment variable smuggles test
 * behaviour into the production path.
 */
export const migrateDataFiles = (
  migrations: ReadonlyArray<DataMigration>,
  rename: (from: string, to: string) => void = renameSync,
): void => {
  if (migrations.length === 0) return

  const plan: Array<Move> = []
  for (const m of migrations) {
    const fromBase = join(dataDir, storeFileName(m.fromCube))
    const toBase = join(dataDir, storeFileName(m.toCube))
    if (!existsSync(fromBase)) continue // nothing to migrate -- the old file simply is not here
    // EVERY destination companion is checked, not only the ones the source has: a stale
    // `booktags--bookmarks.sqlite-wal` left from an aborted run would survive next to the
    // migrated database and corrupt the first read.
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(`${toBase}${suffix}`)) throw new MigrationConflictError(m.fromCube, `${m.toCube}${suffix}`)
    }
    for (const fromPath of companions(fromBase)) {
      const toPath = `${toBase}${fromPath.slice(fromBase.length)}`
      plan.push({ fromPath, toPath })
    }
  }

  const done: Array<Move> = []
  try {
    for (const mv of plan) {
      rename(mv.fromPath, mv.toPath)
      done.push(mv)
    }
  } catch (e) {
    const failed = plan[done.length] as Move
    let rollbackFailed = false
    for (const mv of done.reverse()) {
      try {
        renameSync(mv.toPath, mv.fromPath)
      } catch {
        // A rollback that itself fails is reported in the error, not hidden: the operator
        // must know the directory may be partial.
        rollbackFailed = true
        console.error(`migration rollback could not restore "${mv.toPath}" -> "${mv.fromPath}"`)
      }
    }
    throw new MigrationFailedError(failed.fromPath, failed.toPath, (e as Error).message, rollbackFailed)
  }
}
