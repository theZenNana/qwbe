import { expect, it } from "@effect/vitest"
import { adminUrl, COMPOSE_ARGV, cleanSummary, dropStatement, LEAK_PREFIXES, leakSearch } from "./db-pure.ts"

it("up starts only postgres, detached; down stops the stack", () => {
  expect(COMPOSE_ARGV.up).toEqual(["docker", "compose", "up", "-d", "postgres"])
  expect(COMPOSE_ARGV.down).toEqual(["docker", "compose", "down"])
})

it("the leak prefixes never match the demo database", () => {
  expect(LEAK_PREFIXES.some((prefix) => "qwbe_crm_local".startsWith(prefix))).toBe(false)
  expect(LEAK_PREFIXES).toContain("qwbe_booktags_")
})

it("escapes LIKE wildcards so a prefix matches only itself", () => {
  expect(leakSearch(["qwbe_test_"]).values).toEqual(["qwbe\\_test\\_%"])
})

it("queries one LIKE parameter per prefix", () => {
  expect(leakSearch(["a_", "b_"]).text).toBe(
    "SELECT datname FROM pg_database WHERE datname LIKE $1 OR datname LIKE $2 ORDER BY datname",
  )
})

it("quotes the database name it drops", () => {
  expect(dropStatement('qwbe_test_a"b')).toBe('DROP DATABASE "qwbe_test_a""b" WITH (FORCE)')
})

it("admin URL encodes the credentials", () => {
  expect(adminUrl("db", "5433", "postgres", "p@ss")).toBe("postgres://postgres:p%40ss@db:5433/postgres")
  expect(adminUrl(undefined, undefined, undefined, undefined)).toBe("postgres://postgres:qwbe@localhost:5433/postgres")
})

it("summarizes what clean did", () => {
  expect([cleanSummary(0), cleanSummary(2)]).toEqual(["db clean: nothing to drop", "db clean: 2 database(s) dropped"])
})
