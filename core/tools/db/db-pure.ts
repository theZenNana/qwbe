// Decisions of the db tool; db.ts does the I/O.

export const COMPOSE_ARGV = {
  up: ["docker", "compose", "up", "-d", "postgres"],
  down: ["docker", "compose", "down"],
} as const

// Databases that killed test runs leak; left in place they make every later run crawl. Explicit
// prefixes only, so the demo stack's qwbe_crm_local can never match.
export const LEAK_PREFIXES = ["qwbe_qwb50_", "qwbe_ticket05_", "qwbe_test_", "qwbe_probe_", "qwbe_booktags_"] as const

// The admin connection from the QWBE_PG_* values; each unset one falls back to the local stack.
export const adminUrl = (
  host: string | undefined,
  port: string | undefined,
  user: string | undefined,
  password: string | undefined,
) => {
  const url = new URL("postgres://localhost/postgres")
  url.hostname = host ?? "localhost"
  url.port = port ?? "5433"
  url.username = user ?? "postgres"
  url.password = password ?? "qwbe"
  return url.toString()
}

// One LIKE parameter per prefix. LIKE treats `_` as a wildcard; escaped, each prefix matches only itself.
export const leakSearch = (prefixes: ReadonlyArray<string>) => ({
  text: `SELECT datname FROM pg_database WHERE ${prefixes.map((_, i) => `datname LIKE $${i + 1}`).join(" OR ")} ORDER BY datname`,
  values: prefixes.map((prefix) => `${prefix.replaceAll("_", "\\_")}%`),
})

export const dropStatement = (name: string) => `DROP DATABASE "${name.replaceAll('"', '""')}" WITH (FORCE)`

export const cleanSummary = (count: number) =>
  count === 0 ? "db clean: nothing to drop" : `db clean: ${count} database(s) dropped`
