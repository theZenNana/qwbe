// Decisions of the db tool; db.ts does the I/O.

import type { Argv } from "../shared/process.ts"

// Commands each subcommand runs, in order. `up` waits for the healthcheck, then creates
// pg_stat_statements in the `postgres` database the Grafana datasource reads; the view is
// server-wide once it exists there. psql runs inside the container over its socket.
export const COMPOSE_STEPS: Record<"up" | "down", ReadonlyArray<Argv>> = {
  up: [
    ["docker", "compose", "up", "-d", "--wait", "postgres"],
    [
      ...["docker", "compose", "exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "postgres"],
      ...["-v", "ON_ERROR_STOP=1", "-c", "CREATE EXTENSION IF NOT EXISTS pg_stat_statements"],
    ] as const,
  ],
  down: [["docker", "compose", "down"]],
}

// Databases that killed test runs leak; left in place they make every later run crawl. Explicit
// prefixes only, so the demo stack's qwbe_crm_local can never match.
export const LEAK_PREFIXES = ["qwbe_qwb50_", "qwbe_ticket05_", "qwbe_test_", "qwbe_probe_", "qwbe_booktags_"] as const

// One LIKE parameter per prefix. LIKE treats `_` as a wildcard; escaped, each prefix matches only itself.
export const leakSearch = (prefixes: ReadonlyArray<string>) => ({
  text: `SELECT datname FROM pg_database WHERE ${prefixes.map((_, i) => `datname LIKE $${i + 1}`).join(" OR ")} ORDER BY datname`,
  values: prefixes.map((prefix) => `${prefix.replaceAll("_", "\\_")}%`),
})

export const dropStatement = (name: string) => `DROP DATABASE "${name.replaceAll('"', '""')}" WITH (FORCE)`

export const cleanSummary = (count: number) =>
  count === 0 ? "db clean: nothing to drop" : `db clean: ${count} database(s) dropped`
