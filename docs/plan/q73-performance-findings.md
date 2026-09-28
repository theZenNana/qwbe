# Qwbe#73: where request time goes (first findings)

Measured 2026-09-28 on ai-max (Ryzen AI Max, NVMe, Postgres 16 in Docker), branch
`feature/q73-request-profiler`, with `npm run bench:api` (10,000 seeded rows per list cube,
concurrency 1 and 20) and the dev profiler on
(`QWBE_TRACE_URL=http://127.0.0.1:4318 QWBE_PROFILE=requests,resources,process`), traces read
from the local Grafana LGTM (Tempo) with `/tmp/claude/trace-waterfall.mjs`.

## Numbers (first 22 routes; the run stopped on a request timeout at the 23rd)

Two groups:

- Fast: `GET /account/{id}`, `/auth/me`, `/catalog/{cube}/metadata`, `/cli/commands`, `/links`,
  `/links/{entity}/{id}`, `GET /customfields`: p99 3-10 ms at concurrency 1, 17-60 ms at 20.
- Slow, and 12-16 times slower under load: `GET /customfields/values` 36 -> 487 ms,
  `/customfields/orphans` 32 -> 479, `/echo/feed` 32 -> 340, `/links/{entity}/{id}/{cube}`
  37 -> 515, `POST /customfields` 103 -> 1586, `PUT /customfields/values` 93 -> 1416,
  `PATCH /customfields/{id}` 63 -> 1022, `POST /account` 69 -> 563, `POST /auth/login`
  98 -> 1008 (login is also scrypt, slow on purpose), `POST /cli/exec` 36 -> 499.

A 12-16x rise from 1 to 20 concurrent requests means requests wait for each other: the work is
serial, not parallel.

## One waterfall: `GET /customfields/values` at concurrency 20, 492 ms

| offset ms | duration ms | span |
|---|---|---|
| 0 | 492 | `http.server GET`, cube `customfields`, process CPU in the window 680 ms |
| 0-17 | 17 | four transactions before the handler: auth session, account, permission memberships, capability grants; each `SELECT COUNT(*)` then `SELECT *` filtered on `body ->> $1 = $2` |
| 17-244 | 227 | nothing: the transaction waits before its first statement |
| 244 | 175 | `SELECT * FROM "customfields"."customfield_defs" WHERE deleted = false ORDER BY created_at ASC` (all 10,000 definitions) |
| 479 | 13 | the notes row the values belong to |

## Causes (evidence above; rows marked "guess" are not proven yet)

1. **Whole tables read to answer a narrow question.** `store.all(table)`
   (`core/src/pg/store.ts:101`) returns every live row; callers filter in JavaScript. Seen:
   `customfield_defs` (175 ms here), and the permissions ownership table (the benchmark agent saw
   its full read restarting continuously in `pg_stat_statements`).
2. **Every lookup counts first.** `store.page` (`core/src/pg/store.ts:118`) runs `COUNT(*)` before
   the `SELECT`, also for single-row lookups such as the session behind a token: two scans where
   one `LIMIT 1` would do.
3. **Filters on JSON with no index.** Lookups filter on `body ->> field = value`
   (`core/src/pg/rows.ts:142`); nothing indexes those expressions, so each is a sequential scan.
   Cheap at 100 rows, not at 10,000.
4. **Parsing large result sets blocks the event loop** (guess, consistent with the 227 ms wait and
   680 ms of process CPU in a 492 ms request): while one request turns 10,000 rows into objects,
   every other request on the single Node thread waits. This is why the slowdown multiplies under
   load. Fixing 1-3 should remove most of it; confirm with `qwbe_process_event_loop_delay_p99_ms`
   before and after.

Not the cause, checked: the `authorization` header is recorded on spans only as `<redacted>`.
Disk, driver and database engine: no evidence against them yet; do not swap them before 1-3 are
fixed and measured again.

## Fix plan (Qwbe#73 ticket 09)

- In the store, once for every cube: a lookup path that is one `SELECT ... LIMIT`, no count
  (`page` counts only when the caller needs a total); `all` stays only where every row is truly
  needed, and each current caller that filters in JavaScript passes its filter to SQL instead.
- Expression indexes on the JSON fields that lookups filter on, declared where the table is
  declared (the kernel creates them with the table).
- Re-run `npm run bench:api` and compare; tighten the budgets in `qwbe.yaml` to the new numbers.
