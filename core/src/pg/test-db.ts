// A fresh, throwaway database per test file or `qwbe check` run.
//
// `testDatabase` creates `qwbe_test_<label>_<random>` on the server named by the QWBE_PG_*
// variables (or the local docker-compose default) and returns a connection string to THAT
// database. Files do not share a database, so they run in parallel without seeing each other's
// rows. Creation and `DROP ... WITH (FORCE)` are one acquireRelease: whatever fails after the
// CREATE -- a store that does not boot, a hook that throws -- the scope still drops the
// database, so a failed run leaves no `qwbe_test_*` behind.

import { randomBytes } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { Data, Effect, Layer } from "effect"
import pg from "pg"
import { testConfigLayer } from "../test-config.ts"
import { adminUrl } from "./admin-url.ts"
import { closeAll, initStoreWith, type Pg, run } from "./db.ts"

export class TestDbUnavailable extends Data.TaggedError("TestDbUnavailable")<{ readonly cause: unknown }> {
  override get message() {
    return `could not create a test database (is Postgres up? npm run db:up): ${String(this.cause)}`
  }
}

const unavailable = (cause: unknown) => new TestDbUnavailable({ cause })

const admin = (url: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const client = new pg.Client({ connectionString: url })
        await client.connect()
        return client
      },
      catch: unavailable,
    }),
    (client) => Effect.promise(() => client.end()),
  )

/**
 * The URL of a new database, dropped when the scope closes. Bounded: a Postgres out of
 * connections must fail here before vitest kills the worker, or the finalizers that stop servers
 * and drop databases never run.
 */
export const testDatabase = (label: string) =>
  Effect.gen(function* () {
    const base = yield* Effect.mapError(adminUrl, unavailable)
    const name = `qwbe_test_${label}_${randomBytes(4).toString("hex")}`
    const client = yield* admin(base)
    yield* Effect.acquireRelease(
      Effect.tryPromise({ try: () => client.query(`CREATE DATABASE "${name}"`), catch: unavailable }),
      () =>
        Effect.tryPromise(() => client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)).pipe(
          Effect.timeout("20 seconds"),
          Effect.ignore,
        ),
    )
    const url = new URL(base)
    url.pathname = `/${name}`
    return url.toString()
  }).pipe(Effect.timeoutFail({ duration: "20 seconds", onTimeout: () => unavailable("timed out") }))

/**
 * The kernel store on a new test database, as a layer for `@effect/vitest`'s `layer(...)`: the
 * store is closed before the database is dropped.
 */
export const testStore = (label: string) =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const url = yield* testDatabase(label)
      yield* Effect.acquireRelease(
        Effect.promise(() => initStoreWith(testConfigLayer({ QWBE_DATABASE_URL: url }))),
        () => Effect.promise(closeAll),
      )
    }),
  )

/** SQL on the store's pool, for assertions and fixtures. */
export const withSql = <A, E>(f: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, Pg>): Effect.Effect<A> =>
  run(Effect.flatMap(SqlClient.SqlClient, f))
