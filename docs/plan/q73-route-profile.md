# Qwbe#73: per-route resource profile and memory test

Measured 2026-09-28 ~23:25 on ai-max, branch `feature/q73-request-profiler` at `2f327f5`, with
`QWBE_TRACE_URL=http://127.0.0.1:4318 QWBE_PROFILE=requests,resources,process npm run bench:api`
(10,000 seeded rows per list cube). Numbers from Tempo spans and Prometheus process gauges.

How to read it:
- `ms`, `CPU ms` and `heap delta KB` are medians over the requests that overlapped no other request
  (the concurrency-1 phase): CPU and heap are process-wide deltas over the request window, so only
  isolated requests measure one request.
- `response bytes` is the body size (the network cost; everything ran on localhost).
- `SQL stmts`, `SQL ms` and `tx` come from one median trace per route (`SET LOCAL ROLE` counts as a
  statement; every store call is its own transaction under the cube's role).
- `POST /account` and `POST /auth/login` spend their CPU in scrypt, on purpose.
- The custom field writes still re-read 10,000 definitions here because every seeded clone has the
  same target cube; with real data a write re-reads only its own cube's definitions.

## Memory

Sustained load on the dev API (throwaway database, 20 concurrent clients, 11 routes including note
creation): 38,825 requests in 240 s, all 200. Heap after GC swung between 72 and 246 MB and kept
returning to 75-97 MB; RSS rose to about 650 MB in the first minute and stayed flat (627-665 MB)
for the next three. Two heap snapshots, before and after: 81.2 MB -> 82.4 MB of live objects, the
1.2 MB almost all JIT-compiled code; the only growing class, `PerformanceResourceTiming` (251), is
the OTLP exporter's fetch timings, which Node caps at 250 entries. No leak found.

During the benchmark itself (seeding 10,000 rows per cube, then all routes) heap after GC went
from 61 to 121 MB; before the store and list fixes the same run reached 351 MB.

## Per route

Window 2026-09-28T20:22:19.000Z .. 2026-09-28T20:23:10.000Z: 1987 requests, 74 routes, 527 isolated.

Process: heap after GC 61 -> 121 MB (max 121); heap used max 128 MB; RSS 455 -> 878 MB (max 878); event loop delay p99 max 108.1 ms; GC pause max 221.1 ms; CPU max 85.6%.
| route | req | ms (c1 median) | CPU ms | heap delta KB | response bytes | SQL stmts | SQL ms | tx | 5xx |
|---|---|---|---|---|---|---|---|---|---|
| `POST /account` | 28 | 65.3 | 67.0 | 4489 | 186 | 13 | 19.0 | 6 | 0 |
| `POST /customfields` | 28 | 65.1 | 65.3 | 6529 | 232 | 17 | 36.9 | 8 | 0 |
| `GET /staging/sets` | 27 | 37.6 | 42.0 | 20127 | 2088016 | 10 | 18.1 | 5 | 0 |
| `GET /permissions/entities/:cube` | 27 | 36.8 | 40.3 | 14040 | 3802 | 16 | 21.0 | 8 | 0 |
| `PATCH /customfields/:id` | 27 | 33.3 | 35.4 | 3219 | 218 | 18 | 19.2 | 8 | 0 |
| `POST /auth/login` | 29 | 37.5 | 33.6 | 1615 | 94 | 11 | 2.9 | 5 | 0 |
| `DELETE /customfields/:id` | 27 | 32.5 | 33.4 | 3425 | 27 | 16 | 18.8 | 7 | 0 |
| `GET /echo/feed` | 27 | 29.0 | 22.0 | -5378 | 18556 | 32 | 4.3 | 14 | 0 |
| `GET /settings/cubes` | 27 | 13.1 | 16.5 | 2806 | 3904 | 8 | 0.9 | 4 | 0 |
| `POST /settings/cubes/:name` | 27 | 12.5 | 9.2 | 14202 | 283 | 15 | 1.5 | 7 | 0 |
| `PATCH /echo/comments/:id` | 27 | 14.5 | 8.1 | 7620 | 285 | 22 | 2.1 | 10 | 0 |
| `POST /permissions/entities/:cube/:entityType/:entityId/visibility` | 27 | 14.0 | 7.8 | 7335 | 378 | 29 | 7.8 | 14 | 0 |
| `GET /permissions/entities/:cube/:entityType/:entityId/grants` | 27 | 6.5 | 5.8 | 8524 | 13569 | 10 | 2.8 | 5 | 0 |
| `POST /echo/comments` | 28 | 16.0 | 5.8 | 7449 | 569 | 21 | 2.3 | 9 | 0 |
| `POST /settings/packages/scan` | 27 | 4.5 | 5.5 | 4466 | 626 | 10 | 0.7 | 5 | 0 |
| `GET /permissions/capabilities` | 27 | 5.9 | 5.1 | 8766 | 227145 | 10 | 2.5 | 5 | 0 |
| `DELETE /echo/comments/:id` | 27 | 10.8 | 4.8 | 7263 | 308 | 20 | 2.0 | 9 | 0 |
| `GET /contracts` | 27 | 6.1 | 4.8 | 1774 | 4646 | 14 | 3.1 | 6 | 0 |
| `POST /permissions/capabilities/user` | 28 | 6.6 | 4.0 | 2188 | 250 | 19 | 2.9 | 9 | 0 |
| `GET /account` | 27 | 6.7 | 3.8 | 2141 | 4521 | 13 | 4.4 | 6 | 0 |
| `GET /crm` | 27 | 4.4 | 3.5 | 5947 | 187 | 8 | 0.7 | 4 | 0 |
| `DELETE /permissions/grants/:grantId` | 27 | 7.5 | 3.4 | 1807 | 27 | 17 | 2.7 | 7 | 0 |
| `GET /account/:id` | 27 | 2.5 | 2.8 | 1553 | 177 | 10 | 1.0 | 5 | 0 |
| `POST /views` | 28 | 13.1 | 2.8 | 2549 | 262 | 24 | 5.7 | 10 | 0 |
| `GET /permissions/audit` | 27 | 19.7 | 2.7 | 2126 | 24800 | 11 | 16.5 | 5 | 0 |
| `POST /staging/sets/:id/chunks` | 27 | 6.4 | 2.4 | 1976 | 27 | 19 | 2.4 | 8 | 0 |
| `POST /organizations` | 28 | 11.1 | 2.3 | 2599 | 427 | 24 | 4.9 | 10 | 0 |
| `POST /permissions/entities/:cube/:entityType/:entityId/grants/group` | 27 | 7.4 | 2.3 | 2039 | 270 | 18 | 2.0 | 8 | 0 |
| `PATCH /organizations/:id` | 27 | 6.8 | 2.3 | 2093 | 412 | 20 | 2.1 | 8 | 0 |
| `POST /notes` | 28 | 10.6 | 2.3 | 2672 | 194 | 24 | 4.1 | 10 | 0 |
| `GET /contacts` | 27 | 5.2 | 2.2 | 2577 | 66 | 23 | 1.9 | 11 | 0 |
| `POST /permissions/entities/:cube/:entityType/:entityId/owner` | 27 | 8.8 | 2.2 | 2539 | 203 | 23 | 4.0 | 10 | 0 |
| `GET /organizations` | 27 | 8.0 | 2.2 | 2005 | 10296 | 14 | 4.7 | 6 | 0 |
| `PATCH /permissions/groups/:groupId` | 27 | 6.7 | 2.1 | 2078 | 145 | 19 | 1.9 | 8 | 0 |
| `POST /contracts` | 28 | 10.6 | 2.1 | 2557 | 201 | 24 | 4.2 | 10 | 0 |
| `DELETE /staging/sets/:id` | 27 | 5.0 | 2.1 | 1860 | 25 | 18 | 2.0 | 8 | 0 |
| `GET /customfields` | 27 | 4.4 | 2.0 | 1591 | 5396 | 11 | 2.7 | 5 | 0 |
| `POST /contacts` | 28 | 10.3 | 2.0 | 2555 | 236 | 24 | 4.1 | 10 | 0 |
| `GET /openapi.json` | 2 | 3.3 | 2.0 | 141 | 0 | 0 | 0.0 | 0 | 0 |
| `GET /settings/packages` | 27 | 2.4 | 1.9 | 2224 | 2 | 8 | 0.8 | 4 | 0 |
| `PATCH /contacts/:id` | 27 | 6.1 | 1.9 | 2065 | 220 | 20 | 1.8 | 8 | 0 |
| `GET /customfields/orphans` | 27 | 2.8 | 1.9 | 1541 | 29 | 12 | 1.6 | 6 | 0 |
| `PATCH /views/:id` | 27 | 6.1 | 1.8 | 2075 | 242 | 20 | 1.6 | 8 | 0 |
| `POST /permissions/entities/:cube/:entityType/:entityId/grants/user` | 28 | 6.9 | 1.8 | 2260 | 293 | 20 | 2.3 | 9 | 0 |
| `POST /permissions/groups/:groupId/members` | 27 | 3.5 | 1.8 | 2141 | 207 | 18 | 1.8 | 9 | 0 |
| `DELETE /permissions/capabilities/:grantId` | 27 | 5.9 | 1.8 | 2000 | 25 | 19 | 1.5 | 8 | 0 |
| `GET /catalog/:cube/metadata` | 27 | 1.9 | 1.7 | 1299 | 1896 | 8 | 0.6 | 4 | 0 |
| `POST /permissions/groups` | 28 | 6.3 | 1.7 | 1822 | 168 | 16 | 1.6 | 7 | 0 |
| `GET /links/:entity/:id` | 27 | 4.2 | 1.7 | 1805 | 288 | 15 | 1.2 | 7 | 0 |
| `POST /cli/exec` | 27 | 3.4 | 1.6 | 1735 | 54 | 12 | 1.8 | 6 | 0 |
| `POST /permissions/capabilities/group` | 27 | 4.4 | 1.6 | 1967 | 227 | 17 | 1.3 | 8 | 0 |
| `POST /permissions/cube-admins` | 27 | 5.0 | 1.6 | 2214 | 51 | 19 | 1.9 | 9 | 0 |
| `DELETE /views/:id` | 27 | 5.9 | 1.6 | 1804 | 238 | 18 | 1.5 | 7 | 0 |
| `GET /views/:id` | 27 | 4.2 | 1.6 | 1464 | 243 | 13 | 1.3 | 6 | 0 |
| `POST /staging/sets/:id/sensitive` | 27 | 4.3 | 1.6 | 1741 | 46 | 16 | 1.3 | 7 | 0 |
| `PUT /customfields/values` | 27 | 2.2 | 1.5 | 2098 | 53 | 16 | 0.9 | 8 | 0 |
| `GET /staging/sets/:id/profile` | 27 | 2.9 | 1.5 | 1901 | 155 | 19 | 1.5 | 8 | 0 |
| `GET /notes` | 27 | 6.0 | 1.4 | 1676 | 4471 | 14 | 2.8 | 6 | 0 |
| `POST /staging/sets/:id/finish` | 27 | 3.9 | 1.4 | 1471 | 36 | 14 | 1.3 | 6 | 0 |
| `GET /staging/sets/:id` | 27 | 2.4 | 1.3 | 1175 | 208 | 10 | 1.1 | 5 | 0 |
| `GET /notes/:id` | 27 | 3.8 | 1.3 | 1539 | 175 | 13 | 1.1 | 6 | 0 |
| `GET /links/:entity/:id/:cube` | 27 | 3.7 | 1.3 | 1608 | 66 | 14 | 1.0 | 6 | 0 |
| `GET /organizations/:id` | 27 | 3.8 | 1.2 | 1473 | 408 | 13 | 1.1 | 6 | 0 |
| `GET /views` | 27 | 5.6 | 1.2 | 1602 | 6171 | 14 | 2.8 | 6 | 0 |
| `POST /staging/sets` | 28 | 3.7 | 1.2 | 1495 | 227 | 13 | 0.9 | 6 | 0 |
| `GET /cli/commands` | 27 | 1.9 | 1.2 | 1196 | 1865 | 8 | 0.7 | 4 | 0 |
| `GET /customfields/values` | 27 | 2.1 | 1.2 | 1550 | 53 | 12 | 0.8 | 6 | 0 |
| `GET /permissions/groups` | 27 | 2.0 | 1.1 | 1518 | 14753 | 10 | 0.9 | 5 | 0 |
| `GET /contacts/:id` | 27 | 3.6 | 1.1 | 1461 | 216 | 13 | 1.0 | 6 | 0 |
| `GET /contracts/:id` | 27 | 3.6 | 1.0 | 1464 | 182 | 13 | 1.0 | 6 | 0 |
| `GET /permissions/cube-admins` | 27 | 1.7 | 1.0 | 1213 | 2 | 10 | 0.7 | 5 | 0 |
| `GET /auth/me` | 27 | 1.7 | 1.0 | 1246 | 548 | 8 | 0.7 | 4 | 0 |
| `GET /permissions/groups/:groupId/members` | 27 | 1.6 | 0.9 | 1431 | 66 | 12 | 0.7 | 6 | 0 |
| `GET /links` | 27 | 1.5 | 0.9 | 1022 | 251 | 8 | 0.6 | 4 | 0 |
