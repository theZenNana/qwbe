import * as FetchHttpClient from "@effect/platform/FetchHttpClient"
import type * as HttpClient from "@effect/platform/HttpClient"
import * as Effect from "effect/Effect"
import pg from "pg"
import { bench, inject } from "vitest"
import { BENCH } from "../../tools/bench-budget-pure.ts"
import { call, login } from "../_layers/api-client.ts"
import { USERS } from "../_layers/boot.ts"

// Replaces the timing half of probes/list.mjs (its correctness half is kernel/list.test.ts): on
// 60,000 accounts, paging and filtering run in Postgres, so a deep page costs about what the
// first one does. tools/bench-budget.ts holds the medians to bench.list60k in qwbe.yaml.

const ROWS = 60_000

const PLANT = `INSERT INTO "account"."accounts" (id, type, created_at, deleted, version, body)
  SELECT 'acc-p' || lpad(g::text, 7, '0'), 'Account', now() - (g || ' seconds')::interval, false, 1,
    jsonb_build_object('username', 'user-' || lpad(g::text, 6, '0'), 'displayName', 'User ' || lpad(g::text, 6, '0'),
      'email', 'u' || lpad(g::text, 6, '0') || '@example.test', 'roles', jsonb_build_array('reader'), 'passwordHash', 'x')
  FROM generate_series(0, ${ROWS - 1}) g`

const IDS = Array.from({ length: 150 }, (_, i) => `acc-p${String(i * 391).padStart(7, "0")}`).join(",")

const QUERIES: ReadonlyArray<readonly [string, string]> = [
  [BENCH.listFirst, "?page=1&pageSize=200&sort=username"],
  [BENCH.listDeep, "?page=300&pageSize=200&sort=username"],
  [`${BENCH.listPrefix} page 300 default order`, "?page=300&pageSize=200"],
  [`${BENCH.listPrefix} one exact match`, "?username=user-042000&pageSize=1"],
  [`${BENCH.listPrefix} prefix search`, "?q=user-0042&pageSize=25"],
  [`${BENCH.listPrefix} 150 ids`, `?ids=${IDS}`],
  [`${BENCH.listPrefix} first page, no filter`, "?pageSize=25"],
]

// One warm-up, then seven timed requests each; the median is what the budget reads.
const OPTIONS = { iterations: 7, time: 0, warmupIterations: 1, warmupTime: 0 }

const run = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
  Effect.runPromise(Effect.provide(effect, FetchHttpClient.layer))

// A refused request is not a fast answer: anything but 200 fails the bench.
const listed = (base: string, token: string, query: string) =>
  call(base, `/account${query}`, { token }).pipe(
    Effect.filterOrDie(
      (reply) => reply.status === 200,
      (reply) => new Error(`GET /account${query} answered ${reply.status}`),
    ),
  )

const plant = (url: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new pg.Pool({ connectionString: url, max: 1 })),
    (pool) => Effect.promise(() => pool.query(PLANT)),
    (pool) => Effect.promise(() => pool.end()),
  )

const { base, url } = inject("benchServer")
const token = await run(login(base, "admin", USERS.admin))
await run(listed(base, token, "?pageSize=1")) // the cube creates its table on first use
await Effect.runPromise(plant(url))

for (const [name, query] of QUERIES) bench(name, () => run(Effect.asVoid(listed(base, token, query))), OPTIONS)
