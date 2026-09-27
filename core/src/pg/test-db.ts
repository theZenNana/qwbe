// A fresh, throwaway database per test file.
//
// `testDatabase` creates `qwbe_test_<label>_<random>` on the server named by the QWBE_PG_*
// variables (or the local docker-compose default) and returns a connection string to THAT
// database. Files do not share a database, so they run in parallel without seeing each other's
// rows. Creation and `DROP ... WITH (FORCE)` are one acquireRelease: whatever fails after the
// CREATE -- a store that does not boot, a hook that throws -- the scope still drops the
// database, so a failed run leaves no `qwbe_test_*` behind.

import { randomBytes } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import pg from "pg"
import { closeAll, initStore, type Pg, run } from "./db.ts"

// The admin connection. Parts, not a URL literal: the test helper composes it from the same
// local-dev defaults docker-compose.yml uses, and every piece can be overridden by the
// environment without editing a file.
const adminUrl = (): string => {
  const u = new URL("postgres://localhost/postgres")
  u.hostname = process.env.QWBE_PG_HOST ?? "localhost"
  u.port = process.env.QWBE_PG_PORT ?? "5433"
  u.username = process.env.QWBE_PG_USER ?? "postgres"
  u.password = process.env.QWBE_PG_PASSWORD ?? "qwbe"
  return u.toString()
}

const admin = Effect.acquireRelease(
  Effect.tryPromise(async () => {
    const client = new pg.Client({ connectionString: adminUrl() })
    await client.connect()
    return client
  }),
  (client) => Effect.promise(() => client.end()),
)

/** The URL of a new database, dropped when the scope closes. */
export const testDatabase = (label: string) =>
  Effect.gen(function* () {
    const name = `qwbe_test_${label}_${randomBytes(4).toString("hex")}`
    const client = yield* admin
    yield* Effect.acquireRelease(
      Effect.tryPromise(() => client.query(`CREATE DATABASE "${name}"`)),
      () =>
        Effect.tryPromise(() => client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)).pipe(
          Effect.timeout("20 seconds"),
          Effect.ignore,
        ),
    )
    const url = new URL(adminUrl())
    url.pathname = `/${name}`
    return url.toString()
  })

/**
 * The kernel store on a new test database for one plain vitest file: env first (the pool reads
 * it when it is built), store closed before the database is dropped.
 */
export const testStore = (label: string) =>
  Effect.gen(function* () {
    process.env.QWBE_DATABASE_URL = yield* testDatabase(label)
    yield* Effect.acquireRelease(Effect.promise(initStore), () => Effect.promise(closeAll))
  })

/** SQL on the store's pool, for assertions and fixtures. */
export const withSql = <A>(f: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown, Pg>): Promise<A> =>
  Effect.runPromise(run(Effect.flatMap(SqlClient.SqlClient, f)))
