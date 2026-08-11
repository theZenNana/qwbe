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
import { readLedger } from "./ledger.ts"
import { type DataMigration, type Manifest, storeFileName } from "./manifest.ts"

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

export class MigrationOwnershipError extends Error {
  constructor(reason: string) {
    super(`Data migration refused by the ownership rules: ${reason}`)
    this.name = "MigrationOwnershipError"
  }
}

type Move = { readonly fromPath: string; readonly toPath: string }

/**
 * Validate every declared migration against the mounted set AND the ledger (ledger.ts).
 *
 *   - `toCube` must be a mounted cube of the SAME package as the declarer;
 *   - `fromCube` must NOT be a currently-mounted cube of another package -- a live cube's
 *     file is not legacy data;
 *   - `fromPlugin` is REQUIRED, and must match the ledger's record for `fromCube`. A file
 *     with no ledger record predates the ledger -- the claim is accepted, or real pre-ledger
 *     data would be stranded.
 */
export const checkMigrationOwnership = (
  definitions: ReadonlyArray<{ name: string; plugin: string | null; definition: { manifest: Manifest } }>,
): Array<DataMigration> => {
  const mounted = new Map(definitions.map((d) => [d.name, d.plugin]))
  const ledger = readLedger()
  const pkg = (p: string | null) => (p === null ? "core" : `plugin "${p}"`)
  const migrations: Array<DataMigration> = []
  for (const { name, plugin, definition } of definitions) {
    for (const m of definition.manifest.dataMigration ?? []) {
      const toPlugin = mounted.get(m.toCube)
      if (toPlugin === undefined) {
        throw new MigrationOwnershipError(
          `"${name}" declares ${m.fromCube} -> ${m.toCube}, but "${m.toCube}" is not mounted. ` +
            `A migration runs only when its destination is.`,
        )
      }
      if (toPlugin !== plugin) {
        throw new MigrationOwnershipError(
          `"${name}" declares ${m.fromCube} -> ${m.toCube}, but "${m.toCube}" belongs to ` +
            `${pkg(toPlugin)} -- not to the declaring package.`,
        )
      }
      const fromMounted = mounted.get(m.fromCube)
      if (fromMounted !== undefined && fromMounted !== plugin) {
        throw new MigrationOwnershipError(
          `"${name}" declares ${m.fromCube} -> ${m.toCube}, but "${m.fromCube}" is a mounted cube of ` +
            `${pkg(fromMounted)} -- its file is live, not legacy. A package can only migrate its OWN history.`,
        )
      }
      if (m.fromPlugin === undefined) {
        throw new MigrationOwnershipError(
          `"${name}" declares ${m.fromCube} -> ${m.toCube} without naming the source package. ` +
            `\`fromPlugin\` is required: the claim is checked against the kernel's ledger -- not trusted.`,
        )
      }
      const recorded = ledger[m.fromCube]
      if (recorded !== undefined && recorded !== m.fromPlugin) {
        throw new MigrationOwnershipError(
          `"${name}" declares ${m.fromCube} came from ${pkg(m.fromPlugin)}, but the ledger records ` +
            `${pkg(recorded)}. The ledger is kernel-written at mount -- the manifest cannot rewrite it.`,
        )
      }
      if (m.fromPlugin !== toPlugin) {
        throw new MigrationOwnershipError(
          `"${name}" declares ${m.fromCube} came from ${pkg(m.fromPlugin)}, but the destination ` +
            `"${m.toCube}" belongs to ${pkg(toPlugin)}. The claimed provenance is not this package's.`,
        )
      }
      migrations.push(m)
    }
  }
  return migrations
}

/** The three files that travel together: the database and its WAL companions. */
const companions = (base: string): ReadonlyArray<string> =>
  [base, `${base}-wal`, `${base}-shm`].filter((p) => existsSync(p))

/**
 * Plan, preflight, move, rollback.
 *
 * Preflight is a SEPARATE pass over the entire batch: every source must exist and every
 * destination must not, for every companion of every migration. Only when the whole plan is
 * clean does the first `renameSync` run. A rename that still throws rolls back what has
 * already moved, so the data directory never holds a half-applied batch.
 */
export const migrateDataFiles = (migrations: ReadonlyArray<DataMigration>): void => {
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
  // Test-only fault injection: QWBE_MIGRATION_FAIL_AT=N makes the Nth rename throw, so the
  // rollback path is exercised with files already moved. Never set in production -- and a
  // production run has no reason to know this exists.
  const failAt = process.env.QWBE_MIGRATION_FAIL_AT ? Number(process.env.QWBE_MIGRATION_FAIL_AT) : -1
  try {
    for (const mv of plan) {
      if (done.length === failAt) throw new Error("injected migration fault (QWBE_MIGRATION_FAIL_AT)")
      renameSync(mv.fromPath, mv.toPath)
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
