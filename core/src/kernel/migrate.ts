// Data migrations between cube schemas, DECLARED by packages and executed by the kernel.
//
// A migration is a `dataMigration` entry in a package's manifest, checked at mount against the
// mounted set and the package's provenance.
//
// The store is one Postgres schema per cube, so a migration is a schema rename -- and a schema
// rename in Postgres is metadata, so the rows move byte for byte with no copying at all:
//
//   ALTER SCHEMA "old" RENAME TO "new"   (plus the matching role rename)
//
// inside ONE transaction. The rules that keep a plugin from reaching outside itself are
// unchanged and live in `migrate-ownership.ts`; the preflight here is the same shape it was
// with files: EVERY migration is checked before a single rename runs, and a failed move rolls
// the whole batch back.

import { SqlClient, SqlError } from "@effect/sql"
import { Cause, Data, Effect, Exit } from "effect"
import { reason, run } from "../pg/db.ts"
import { ident, roleName, schemaExists, schemaName } from "../pg/setup.ts"
import type { DataMigration } from "./manifest.ts"

export { MigrationOwnershipError } from "./migrate-ownership.ts"

export class MigrationConflictError extends Data.TaggedError("MigrationConflictError")<{ readonly message: string }> {
  constructor(from: string, to: string) {
    super({
      message:
        `Data migration refused: the schemas for both "${from}" and "${to}" exist in the database. ` +
        `One of them must be removed by hand -- choosing one silently would be choosing which ` +
        `data to lose.`,
    })
  }
}

export class MigrationFailedError extends Data.TaggedError("MigrationFailedError")<{ readonly message: string }> {
  constructor(from: string, to: string, cause: string, rollbackFailed: boolean) {
    super({
      message: rollbackFailed
        ? `Data migration failed moving "${from}" to "${to}": ${cause}. ` +
          `The rollback ALSO failed for at least one schema (logged above) -- the database ` +
          `may hold a partial batch. Inspect it before restarting.`
        : `Data migration failed moving "${from}" to "${to}" and the batch was rolled back: ${cause}`,
    })
  }
}

type Move = { readonly fromSchema: string; readonly toSchema: string }

const messageOf = (cause: Cause.Cause<unknown>): string => {
  const e = Cause.squash(cause)
  return e instanceof SqlError.SqlError ? reason(e) : e instanceof Error ? e.message : String(e)
}

/**
 * Plan, preflight, rename, rollback.
 *
 * Preflight is a SEPARATE pass over the entire batch: every source schema must exist and every
 * destination must not. Only when the whole plan is clean does the first rename run. A rename
 * that still fails (or dies) rolls back what has moved.
 *
 * `rename` is a parameter, not an import: the production caller passes the Postgres
 * implementation, a test passes a function that fails at a chosen move -- no environment
 * variable smuggles test behaviour into the production path.
 */
export const migrateDataSchemas = (
  migrations: ReadonlyArray<DataMigration>,
  exists: (schema: string) => Effect.Effect<boolean, unknown> = (schema) => run(schemaExists(schema)),
  rename: (fromSchema: string, toSchema: string) => Effect.Effect<void, unknown> = (from, to) =>
    run(renameSchema(from, to)),
): Effect.Effect<void, MigrationConflictError | MigrationFailedError> =>
  Effect.gen(function* () {
    const plan: Array<Move> = []
    for (const m of migrations) {
      const from = schemaName(m.fromCube)
      const to = schemaName(m.toCube)
      if (!(yield* Effect.orDie(exists(from)))) continue // nothing to migrate -- the old schema simply is not here
      if (yield* Effect.orDie(exists(to))) return yield* new MigrationConflictError(m.fromCube, m.toCube)
      plan.push({ fromSchema: from, toSchema: to })
    }

    const done: Array<Move> = []
    for (const mv of plan) {
      const moved = yield* Effect.exit(rename(mv.fromSchema, mv.toSchema))
      if (Exit.isSuccess(moved)) {
        done.push(mv)
        continue
      }
      let rollbackFailed = false
      for (const back of done.reverse()) {
        if (Exit.isFailure(yield* Effect.exit(rename(back.toSchema, back.fromSchema)))) {
          // A rollback that itself fails is reported in the error, not hidden: the operator
          // must know the database may hold a partial batch.
          rollbackFailed = true
          yield* Effect.logError(`migration rollback could not restore "${back.toSchema}" -> "${back.fromSchema}"`)
        }
      }
      return yield* new MigrationFailedError(mv.fromSchema, mv.toSchema, messageOf(moved.cause), rollbackFailed)
    }
  })

/**
 * The production rename: schema and its role, in one transaction. A schema rename moves the
 * tables and their rows as metadata; the role is renamed so the next boot's grants spell the
 * new name and no stale `qwbe_cube_<old>` role lingers with its membership.
 */
export const renameSchema = (fromSchema: string, toSchema: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`ALTER SCHEMA ${ident(sql, fromSchema)} RENAME TO ${ident(sql, toSchema)}`
        // ADR-0001 section 5: no state in which the row changed and the event did not. A rename
        // moves every row of the schema, so every table gets an outbox entry in the SAME
        // transaction -- one per table, `row_id = '*'` meaning "the whole table moved".
        const tables = yield* sql<{ t: string }>`SELECT table_name AS t FROM information_schema.tables
                                                 WHERE table_schema = ${toSchema}`
        for (const row of tables) {
          yield* sql`INSERT INTO qwbe.outbox (cube, "table", row_id, op, version)
                     VALUES (${toSchema.replace(/--/g, "/")}, ${row.t}, '*', 'update', 1)`
        }
        // The role is renamed only if it exists: a schema that arrived outside the store's setup
        // (a legacy database, or the migration tool's import) may not have one yet.
        const roles = yield* sql`SELECT 1 FROM pg_roles WHERE rolname = ${roleName(fromSchema)}`
        if (roles.length > 0) {
          yield* sql`ALTER ROLE ${ident(sql, roleName(fromSchema))} RENAME TO ${ident(sql, roleName(toSchema))}`
        }
      }),
    ),
  )
