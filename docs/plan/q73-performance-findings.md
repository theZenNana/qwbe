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

## Full run, all 82 routes (2026-09-28 ~20:40, before any fix)

`npm run bench:api` after the timeout fix, 10,000 seeded rows per list cube, profiler off. Report
kept as the baseline for the comparison after the fixes.

- **Five lists never answer within 10 s**, at concurrency 1 as at 20: `GET /notes`, `GET /views`,
  `GET /permissions/entities/{cube}` (cube `notes`), and the crm-pack lists `GET /contracts`,
  `GET /organizations`. All five check permissions one row at a time over every row of the
  table: `visibleNotesPage` (`core/src/cubes/notes/permissions.ts:27`) and the mediated entity
  list (`core/src/entity-enforcement.ts:142`) call `permissions.authorize` per row, and
  `authorize` reads the permission tables whole (`core/src/cubes/permissions/state.ts:52-63`):
  10,000 rows times full scans of 10,000-row tables.
- **Creates cost about 300 ms alone and 5 s under load**: `POST /notes`, `/views`, `/contacts`,
  `/contracts`, `/organizations` (283-343 ms at c1, 3.9-5.3 s at c20), and
  `POST /permissions/entities/.../owner` 311 ms / 3.1 s. Guess: claiming ownership reads the
  ownership table whole; to confirm after the permissions lookups move.
- **Everything else** that writes sits at 30-100 ms at c1 and 0.5-1.6 s at c20; single-row reads
  at 3-10 ms and 20-30 ms.
- Not performance: `DELETE /permissions/capabilities/{grantId}` and
  `POST /staging/sets/{id}/finish` answer 404 after the first request, because the fixture reuses
  one id for a one-shot action (a benchmark fixture to fix, not a server bug); `GET /organizations`
  answered 500 twice among its timeouts (not investigated yet).

### What the lookups fix will and will not do

Moving `authorize`'s reads to indexed `first`/`where` makes each check a few index lookups
instead of full scans. The lists still make one check per row: 10,000 rows means tens of
thousands of queries per request. The fix that removes that is one check for a whole page of
rows (`authorize` over many refs, a few `= ANY(ids)` queries per page). It adds an operation to
the permission service contract, so it waits for the owner.

## After the lookup fixes (2026-09-28 ~20:55)

Same benchmark, commits `58628ed` (store `first`/`where`, indexes), `466542a` (permissions),
`a43b1fe` (auth, account, customfields, views, notes). p99 in ms, before -> after:

| route | c1 | c20 |
|---|---|---|
| `POST /contracts` | 315 -> 14 | 5264 -> 47 |
| `POST /views` | 290 -> 14 | 4973 -> 45 |
| `POST /notes` | 309 -> 16 | 5051 -> 48 |
| `POST /contacts` | 343 -> 15 | 4951 -> 53 |
| `POST /organizations` | 306 -> 16 | 4962 -> 63 |
| `GET /notes/{id}` | 126 -> 11 | 2148 -> 36 |
| `PUT /customfields/values` | 91 -> 5 | 1461 -> 34 |
| `POST /permissions/entities/.../owner` | 311 -> 13 | 3101 -> 76 |
| `GET /customfields/values` | 35 -> 4 | 509 -> 23 |
| `POST /auth/login` (scrypt) | 94 -> 38 | 997 -> 169 |

Most writes went from 30-100 ms / 0.5-1.6 s to 5-15 ms / 30-70 ms: they were paying for the
permission checks' full scans.

Unchanged: the five lists still time out (one `authorize` per row, see above).
`POST /customfields` (78 / 1115) and `PATCH /customfields/{id}` (73 / 516) are still slow: not
analysed yet. Worse: `GET /permissions/audit` 64 -> 258 / 1126 -> 4315; under investigation with
a traced run.

## Traced run after the lookup fixes (2026-09-28 ~21:05)

Same benchmark with `QWBE_TRACE_URL` and `QWBE_PROFILE=requests,resources,process`, traces read
from Tempo, statement counts from `pg_stat_statements`.

1. **Every `authorize` writes an audit row** (`core/src/cubes/permissions/foundation.ts:35`),
   reads included, each in its own transaction with an outbox row. A list that checks 10,000 rows
   writes up to 10,000 audit rows per request; one benchmark run wrote over 200,000 (one
   `INSERT INTO permission_audit` statement counted 212,365 calls). Faster checks made this
   worse: before the fixes a request finished fewer checks before its timeout.
2. **`GET /permissions/audit` reads the whole audit table** (`audit.ts:15`, `store.all` then
   decode and filter in JavaScript): 1.1 s for the `SELECT` alone, 374 MB of heap, 2.3 s of
   process CPU in one request. This is the `64 -> 258 ms` regression: the table grew (point 1),
   the code did not change. It will keep growing with use.
3. **`GET /notes` now**: in 10 s one request checks 801 of 10,000 notes. Per note: one
   transaction for the ownership lookup (1.7 ms in SQL) and one for the audit insert plus outbox;
   1,608 transactions add up to 9.9 s. Per-row work, not slow SQL.
4. **Four `500`s on `GET /contracts` / `GET /organizations`** (two each): in each, an audit `INSERT` ends
   with `SqlError: Failed to execute statement`, span marked interrupted, 0.3-3.7 s into a request
   that was not timed out. Guess, not proven: a timed-out request is interrupted, the driver
   cancels its statement by backend pid, and the cancel lands on a pooled connection another
   request already uses. Needs a reproduction.
5. **`POST /customfields`** (1.07 s at c20): after each create the snapshot re-reads all 10,000
   definitions (`customfields/context.ts:36`, kept on `all`), plus two `targetCube` lookups that
   match every clone; the rest of the second is JavaScript.
6. **`GET /settings/cubes`** (1.07 s at c20): 383 ms of SQL, the rest in code with no spans; needs
   a CPU profile (ticket 06).

Checked, not a problem: the lookup `body ->> $1 = $2` binds the JSON key as a parameter, which a
generic plan cannot match to the `(body ->> 'field')` index; node-postgres sends unnamed
statements, which Postgres plans with the actual values, so the index is used.

### Decisions for the owner

- **Batch authorization**: one permission check per page of rows instead of one per row. Adds an
  operation to the permission service contract.
- **What the audit records**: an audit row per read decision (today) makes every list write as
  many rows as it reads. Options: audit writes and denials only, or one row per list request.
  Security policy, not a performance detail.
- **Audit listing**: page and filter `GET /permissions/audit` in SQL; changes its response shape
  if it gains paging.

## CPU profile of the benchmark server (2026-09-28 ~21:25)

`NODE_OPTIONS="--cpu-prof --cpu-prof-dir=..." npm run bench:api`, server profile read with a
self-time and an inclusive-time summary. The server was busy 104 s of 398 s (74% idle: the
benchmark waits on timeouts). Effect runs on fibers, so stacks break at every async step and
inclusive times are lower bounds.

- **Self time is spread thin**: the Effect fiber runtime (`fiberRuntime.js`, `fiberRefs`,
  `context`) about a quarter of the busy time, then `pg` row parsing and `postgres-date`,
  `DateTime.formatIso`, socket writes. No single hot function; the cost is the number of small
  effects and rows per request, which the per-row permission checks multiply.
- **`GET /settings/cubes` builds the catalogue about 21 times per request**
  (`cubes/settings/index.ts:140` lists `catalogue()`, then `state-view.ts:7` calls `catalogue()`
  again per cube), each build running `enrichWithCustomFields` and `metadataHash`. Fixed: one
  build per request (a counting test goes from 3 calls to 1 with two cubes).
- Row decoding (`pg/rows.ts:21` `decode`) 4.4 s inclusive, `newId` 1.2 s (the 200,000 audit
  inserts), the audit listing's decode (`permissions/audit.ts:16`) 1.4 s.

## The 500s: row id collisions, proven (2026-09-28 ~21:45)

The guess in point 4 of the traced run above (a cancel landing on a pooled connection) was wrong.
The Postgres log of the runs shows the error behind every 500:

```
ERROR:  duplicate key value violates unique constraint "permission_audit_pkey"
DETAIL:  Key (id)=(audit-6c947ceb) already exists.
```

`newId` (`core/src/pg/rows.ts:19`) made ids from 4 random bytes: 32 bits, a 50% chance of a
collision at about 77,000 rows in one table, routine beyond. The audit table passes 200,000 rows
in one benchmark run (every `authorize` writes one), so inserts started failing at random and the
request answered 500. Any table that grows to tens of thousands of rows would do the same in
production. Fixed by widening the ids (below).
