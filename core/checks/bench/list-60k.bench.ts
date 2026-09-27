import * as Effect from "effect/Effect"
import { bench, inject } from "vitest"
import { BENCH } from "../../tools/check/bench-budget-pure.ts"
import { connect, query } from "../_layers/postgres.ts"
import { benchAdmin, okBody, runHttp } from "./client.ts"

// Replaces the timing half of probes/list.mjs (its correctness half is kernel/list.test.ts): on
// 60,000 accounts, paging and filtering run in Postgres, so a deep page costs about what the
// first one does. tools/check/bench-budget.ts holds the medians to bench.list60k in qwbe.yaml.

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

const plant = (url: string) => Effect.scoped(Effect.flatMap(connect(url), (client) => query(client, PLANT)))

const { base, url } = inject("benchServer")
const admin = await benchAdmin(base)
const listed = (search: string) => okBody(admin.get(`/account${search}`), `GET /account${search}`)

await runHttp(listed("?pageSize=1")) // the cube creates its table on first use
await Effect.runPromise(plant(url))

for (const [name, search] of QUERIES) bench(name, () => runHttp(Effect.asVoid(listed(search))), OPTIONS)
