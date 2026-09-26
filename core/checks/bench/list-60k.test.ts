import { expect, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import pg from "pg"
import { call, login } from "../_layers/api-client.ts"
import { budgets, medianMs } from "../_layers/measure.ts"
import { TestServer, testServer, USERS } from "../_layers/test-server.ts"

// Paging and filtering run in Postgres, so a deep page costs about what the first one does and
// every answer on 60,000 rows stays under the budget in qwbe.yaml (bench.list60k).
const ROWS = 60_000

const PLANT = `INSERT INTO "account"."accounts" (id, type, created_at, deleted, version, body)
  SELECT 'acc-p' || lpad(g::text, 7, '0'), 'Account', now() - (g || ' seconds')::interval, false, 1,
    jsonb_build_object('username', 'user-' || lpad(g::text, 6, '0'), 'displayName', 'User ' || g,
      'email', 'u' || g || '@example.test', 'roles', jsonb_build_array('reader'), 'passwordHash', 'x')
  FROM generate_series(0, ${ROWS - 1}) g`

const plant = (url: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new pg.Pool({ connectionString: url, max: 1 })),
    (pool) => Effect.promise(() => pool.query(PLANT)),
    (pool) => Effect.promise(() => pool.end()),
  )

const listed = (base: string, token: string, query: string) =>
  call(base, `/account${query}`, { token }).pipe(
    Effect.filterOrDie(
      (reply) => reply.status === 200,
      (reply) => new Error(`GET /account${query} answered ${reply.status}`),
    ),
  )

layer(testServer("bench-list"), { timeout: 180_000, excludeTestServices: true })((it) => {
  it.effect(
    "a deep page costs what the first one does, and every answer stays in budget",
    () =>
      Effect.gen(function* () {
        const { base, url } = yield* TestServer
        const budget = (yield* budgets).list60k
        const token = yield* login(base, "admin", USERS.admin)
        yield* listed(base, token, "?pageSize=1") // creates the table before rows are planted
        yield* plant(url)
        const time = (title: string, query: string) => medianMs(`list-60k ${title}`, listed(base, token, query))
        const first = yield* time("page 1 sorted", "?page=1&pageSize=200&sort=username")
        const deep = yield* time("page 300 sorted", "?page=300&pageSize=200&sort=username")
        const others = yield* Effect.all([
          time("page 300 unsorted", "?page=300&pageSize=200"),
          time("one exact match", "?username=user-042000&pageSize=1"),
          time("prefix search", "?q=user-0042&pageSize=25"),
        ])
        expect(deep).toBeLessThan(Math.max(budget.deepPageFloorMs, first * budget.deepPageFactor))
        for (const ms of [first, deep, ...others]) expect(ms).toBeLessThan(budget.anyAnswerMs)
      }),
    180_000,
  )
})
