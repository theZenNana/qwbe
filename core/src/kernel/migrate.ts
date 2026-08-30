// Data migrations between cube schemas, DECLARED by packages and executed by the kernel.
//
// Split out of discovery.ts on 2026-08-11 when the hierarchy work pushed that file past its
// size cap. Rewritten the same day after review: no list of cube names lives here any more --
// a migration is a `dataMigration` entry in a package's manifest, checked at mount against the
// mounted set and the package's provenance.
//
// QWB-44 moved the store from one SQLite file per cube to one Postgres schema per cube, and
// the migration moved with it. What was a file rename is now a schema rename -- and a schema
// rename in Postgres is metadata, so the rows move byte for byte with no copying at all:
//
//   ALTER SCHEMA "old" RENAME TO "new"   (plus the matching role rename)
//
// inside ONE transaction. The rules that keep a plugin from reaching outside itself are
// unchanged and live in `migrate-ownership.ts`; the preflight here is the same shape it was
// with files: EVERY migration is checked before a single rename runs, and a failed move rolls
// the whole batch back.

import type { DataMigration } from "./manifest.ts"
import { getPool } from "./pg/db.ts"
import { q, roleName, schemaExists, schemaName } from "./pg/setup.ts"

export { MigrationOwnershipError } from "./migrate-ownership.ts"

export class MigrationConflictError extends Error {
  constructor(from: string, to: string) {
    super(
      `Data migration refused: the schemas for both "${from}" and "${to}" exist in the database. ` +
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
            `The rollback ALSO failed for at least one schema (logged above) -- the database ` +
            `may hold a partial batch. Inspect it before restarting.`
        : `Data migration failed moving "${from}" to "${to}" and the batch was rolled back: ${cause}`,
    )
    this.name = "MigrationFailedError"
  }
}

type Move = { readonly fromSchema: string; readonly toSchema: string }

/**
 * Plan, preflight, rename, rollback.
 *
 * Preflight is a SEPARATE pass over the entire batch: every source schema must exist and every
 * destination must not. Only when the whole plan is clean does the first rename run. A rename
 * that still throws rolls back what has moved.
 *
 * `rename` is a parameter, not an import: the production caller passes the Postgres
 * implementation, a test passes a function that throws at a chosen move -- no environment
 * variable smuggles test behaviour into the production path.
 */
export const migrateDataSchemas = async (
  migrations: ReadonlyArray<DataMigration>,
  exists: (schema: string) => Promise<boolean> = schemaExists,
  rename: (fromSchema: string, toSchema: string) => Promise<void> = renameSchema,
): Promise<void> => {
  if (migrations.length === 0) return

  const plan: Array<Move> = []
  for (const m of migrations) {
    const from = schemaName(m.fromCube)
    const to = schemaName(m.toCube)
    if (!(await exists(from))) continue // nothing to migrate -- the old schema simply is not here
    if (await exists(to)) throw new MigrationConflictError(m.fromCube, m.toCube)
    plan.push({ fromSchema: from, toSchema: to })
  }

  const done: Array<Move> = []
  try {
    for (const mv of plan) {
      await rename(mv.fromSchema, mv.toSchema)
      done.push(mv)
    }
  } catch (e) {
    const failed = plan[done.length] as Move
    let rollbackFailed = false
    for (const mv of done.reverse()) {
      try {
        await rename(mv.toSchema, mv.fromSchema)
      } catch {
        // A rollback that itself fails is reported in the error, not hidden: the operator
        // must know the database may hold a partial batch.
        rollbackFailed = true
        console.error(`migration rollback could not restore "${mv.toSchema}" -> "${mv.fromSchema}"`)
      }
    }
    throw new MigrationFailedError(failed.fromSchema, failed.toSchema, (e as Error).message, rollbackFailed)
  }
}

/**
 * The production rename: schema and its role, in one transaction. A schema rename moves the
 * tables and their rows as metadata; the role is renamed so the next boot's grants spell the
 * new name and no stale `qwbe_cube_<old>` role lingers with its membership.
 */
export const renameSchema = async (fromSchema: string, toSchema: string): Promise<void> => {
  const p = getPool()
  const client = await p.connect()
  try {
    await client.query("BEGIN")
    await client.query(`ALTER SCHEMA ${q(fromSchema)} RENAME TO ${q(toSchema)}`)
    await client.query(`ALTER ROLE ${q(roleName(fromSchema))} RENAME TO ${q(roleName(toSchema))}`)
    await client.query("COMMIT")
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {})
    throw e
  } finally {
    client.release()
  }
}
