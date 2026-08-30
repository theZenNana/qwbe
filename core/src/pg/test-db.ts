// A fresh, throwaway database per test file.
//
// Each test file calls `createTestDatabase` ONCE, before anything touches the store: the
// helper creates `qwbe_test_<random>` on the server named by QWBE_DATABASE_URL (or the local
// docker-compose default) and hands back a connection string to THAT database. Files do not
// share a database, so they run in parallel without seeing each other's rows, and `drop()`
// at the end removes the database entirely -- no state survives a run, not even an empty
// schema. The admin connection is closed before the store pool is created, so the drop is
// never blocked by our own connections.

import { randomBytes } from "node:crypto"
import pg from "pg"

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

export const createTestDatabase = async (label: string): Promise<{ url: string; drop: () => Promise<void> }> => {
  const name = `qwbe_test_${label}_${randomBytes(4).toString("hex")}`
  const admin = new pg.Pool({ connectionString: adminUrl(), max: 1 })
  await admin.query(`CREATE DATABASE "${name}"`)
  const base = new URL(adminUrl())
  base.pathname = `/${name}`
  const url = base.toString()
  let dropped = false
  return {
    url,
    drop: async () => {
      if (dropped) return
      dropped = true
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {})
      await admin.end()
    },
  }
}
