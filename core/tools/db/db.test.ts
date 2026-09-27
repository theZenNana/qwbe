import { expect, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import { adminUrl } from "../../src/pg/admin-url.ts"
import { COMPOSE_ARGV, cleanSummary, dropStatement, LEAK_PREFIXES, leakSearch } from "./db-pure.ts"

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

it.effect("admin URL encodes the credentials; each unset part is the local stack", () =>
  Effect.gen(function* () {
    // Asserted through its parts: a literal credential URL here is what secretlint rightly flags.
    const parts = (url: string) => {
      const { protocol, username, password, hostname, port, pathname } = new URL(url)
      return [protocol, username, password, hostname, port, pathname]
    }
    const from = (env: Record<string, string>) =>
      Effect.withConfigProvider(adminUrl, ConfigProvider.fromMap(new Map(Object.entries(env))))
    const set = { QWBE_PG_HOST: "db", QWBE_PG_PORT: "5433", QWBE_PG_USER: "postgres", QWBE_PG_PASSWORD: "p@ss" }
    expect(parts(yield* from(set))).toEqual(["postgres:", "postgres", "p%40ss", "db", "5433", "/postgres"])
    expect(parts(yield* from({}))).toEqual(["postgres:", "postgres", "qwbe", "localhost", "5433", "/postgres"])
  }),
)

it("summarizes what clean did", () => {
  expect([cleanSummary(0), cleanSummary(2)]).toEqual(["db clean: nothing to drop", "db clean: 2 database(s) dropped"])
})
