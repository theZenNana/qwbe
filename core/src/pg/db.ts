// One Postgres database, one schema per cube (ADR-0001).
//
// The SQLite file boundary made isolation physical. The move to Postgres buys transactions,
// migrations, jsonb with GIN and a real pool, and spends that physical boundary -- so the
// boundary is rebuilt in the engine: one NOLOGIN role per cube, one schema per cube, and every
// store operation running under `SET LOCAL ROLE` inside its transaction. A cube's connection
// that asks for another cube's schema gets a permission error from Postgres, not a warning
// from lint. See `setup.ts` for the grants and `checks/integration/pg-grants.test.ts` for the proof.
//
// The kernel owns one schema of its own, `qwbe`: `qwbe.migrations` records which numbered SQL
// files under `pg/migrations/` were applied, and `qwbe.outbox` receives one row per write,
// in the same transaction as the write itself (ADR-0001 section 5). Nothing consumes the
// outbox in phase 1.

import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { SqlClient, SqlError } from "@effect/sql"
import { PgClient } from "@effect/sql-pg"
import { Effect, Layer, ManagedRuntime, Runtime } from "effect"
import pg from "pg"
import { readDatabaseUrl } from "../config.ts"
import { type Setup, SetupLive } from "./setup.ts"

const here = dirname(fileURLToPath(import.meta.url))

/**
 * The one connection string. Missing or unreachable at boot means REFUSE TO START: a fallback
 * (SQLite, memory, anything) would create two storage truths and the quiet data loss that
 * follows. The message names the variable, because that is what the operator can fix.
 */
export const databaseUrl = (): string => {
  const url = readDatabaseUrl()
  if (!url) {
    throw new Error(
      "QWBE_DATABASE_URL is not set. qwbe stores every cube in one Postgres database and " +
        "refuses to start without it. Set it, e.g. to the value in .env.example, and start the " +
        "database with `npm run db:up`.",
    )
  }
  return url
}

/** The driver's own message, not the wrapper's "Failed to execute statement". */
export const reason = (e: SqlError.SqlError): string => (e.cause instanceof Error ? e.cause.message : e.message)

const pool = Effect.acquireRelease(
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>()
    const p = new pg.Pool({ connectionString: databaseUrl(), max: 10 })
    // PgClient's own pool listener swallows the error silently; this one says what happened.
    p.on("error", (e: NodeJS.ErrnoException) => {
      // ponytail: one line, no reconnect logic -- the pool replaces a lost client on the next
      // query; without this listener an idle-client error (57P01) is an uncaught exception.
      Runtime.runFork(runtime)(
        Effect.logError(`qwbe: idle Postgres connection lost (${e.code ?? "no code"}): ${e.message}`),
      )
    })
    return p
  }),
  (p) => Effect.promise(() => p.end()),
)

/**
 * Kernel-owned SQL, applied in order, recorded in `qwbe.migrations`. Applied at boot: an
 * unapplied migration runs, a failing one stops the boot -- no guessing, no half-state (the
 * runner is one transaction per file, so a failure leaves no partial DDL behind).
 */
const runMigrations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // An unreachable database fails here, with pg's own error in the message.
  yield* sql`SELECT 1`.pipe(
    Effect.mapError((e) => new SqlError.SqlError({ cause: e.cause, message: `Postgres unreachable: ${reason(e)}` })),
  )
  const dir = join(here, "migrations")
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
  // One session-level advisory lock around the whole loop: two processes booting against the
  // same database must not both run the same file -- the second would die on the
  // qwbe.migrations primary key. Session-scoped locks live per connection, so the lock is
  // taken and held on one reserved connection for the duration and released after the loop.
  const lock = yield* sql.reserve
  yield* Effect.acquireRelease(
    lock.executeUnprepared(`SELECT pg_advisory_lock(hashtext('qwbe-migrations'))`, [], undefined),
    () =>
      Effect.ignore(lock.executeUnprepared(`SELECT pg_advisory_unlock(hashtext('qwbe-migrations'))`, [], undefined)),
  )
  for (const file of files) {
    // Only "relation does not exist" (42P01) means "not applied yet": the kernel schema
    // simply is not there on a first boot. EVERY other failure of this probe -- a dropped
    // connection, a permission error -- must stop the boot, because reading it as "not
    // applied" would re-run an already-applied file.
    const applied = yield* sql`SELECT 1 FROM qwbe.migrations WHERE name = ${file}`.pipe(
      Effect.catchIf(
        (e) => (e.cause as { code?: string } | undefined)?.code === "42P01",
        () => Effect.succeed([]),
      ),
    )
    if (applied.length === 1) continue
    yield* sql
      .withTransaction(
        Effect.zipRight(
          sql.unsafe(readFileSync(join(dir, file), "utf8")),
          sql`INSERT INTO qwbe.migrations (name) VALUES (${file})`,
        ),
      )
      .pipe(
        Effect.mapError(
          (e) =>
            new SqlError.SqlError({
              cause: e.cause,
              message: `Postgres migration "${file}" failed and the boot stopped: ${reason(e)}`,
            }),
        ),
      )
  }
}).pipe(Effect.scoped)

/**
 * The store's whole world: one pool, the kernel schema migrated, the per-cube setup caches.
 * Scoped: the pool ends when the layer's scope closes.
 */
export const PgLive = Layer.mergeAll(SetupLive, Layer.effectDiscard(runMigrations)).pipe(
  Layer.provideMerge(PgClient.layerFromPool({ acquire: pool })),
)

export type Pg = SqlClient.SqlClient | Setup

// ponytail: the one process handle. The CubeStore contract has `R = never`, and cubes run store
// effects on detached fibers (customfields' `Effect.runFork` at boot), so the pool cannot
// travel as a requirement; every store effect reaches it through `run` below. The runtime
// builds PgLive on first use (one pool per process); `closeAll` disposes it and leaves a fresh,
// unbuilt one behind. Replace with a provided layer once the contract carries a requirement.
let runtime = ManagedRuntime.make(PgLive)

/**
 * The contract boundary, in exactly one place: the store's error channel is `never` (see the
 * top of `store.ts`), so a SqlError -- typed everywhere inside core/src/pg -- becomes a defect
 * here, exactly as an unexpected SQLite error was. Cubes cannot "handle" a broken database.
 */
export const run = <A, E>(effect: Effect.Effect<A, E, Pg>): Effect.Effect<A> =>
  Effect.suspend(() => runtime).pipe(
    Effect.flatMap((rt) => Effect.provide(effect, rt.context)),
    Effect.orDie,
  )

/**
 * Boot-time initialisation: connect, make sure the kernel schema exists, apply migrations.
 * Called once from `main.ts` before mount; a schema change applied by a request instead of at
 * boot is exactly the guessing ADR-0001 section 4 forbids.
 */
export const initStore = async (): Promise<void> => {
  await runtime.runtime()
}

/** Close everything. Used by the probes and tests so a run leaves no connections behind. */
export const closeAll = (): Promise<void> => {
  const old = runtime
  runtime = ManagedRuntime.make(PgLive)
  return old.dispose()
}
