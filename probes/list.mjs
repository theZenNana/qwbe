// Probe: the generic list, on a table the size of the data this system is being built for.
// 60,000 rows -- the order of the CRM import (about 60k organizations, 74k contacts).
//
// Three rows prove a code path and nothing about the design. At 60k, a filter that runs in
// JavaScript instead of SQL, a COUNT nobody measured, and an offset deep in the table all show
// up as seconds. So this probe plants the rows, asks every question the contract promises to
// answer, and TIMES the ones whose cost decides whether the design holds.
//
// The rows are planted with one INSERT ... generate_series through the admin connection rather
// than 60,000 POSTs: the subject is the read path.
//
//   node probes/list.mjs

import pg from "pg"
import {
  client,
  dropDatabase,
  dropScratch,
  freePort,
  makeScore,
  scratchDatabase,
  scratchDataDir,
  startServer,
  stopServer,
} from "./lib.mjs"

const ROWS = 60_000
const GROUPS = 10
const port = await freePort()
const data = scratchDataDir("list")
const dbUrl = await scratchDatabase("list")
const score = makeScore()
const api = client(port)

const name = (n) => `user-${String(n).padStart(6, "0")}`
const timings = []

const server = await startServer(port, { QWBE_DATA_DIR: data, QWBE_DATABASE_URL: dbUrl })
if (!server.alive) {
  console.error(`server did not start:\n${server.output}`)
  process.exit(1)
}

let failed = 0
try {
  const admin = await api.login()

  // One read first: a cube's schema and table are created lazily, on first use.
  const seeded = await api.call("/account", { headers: admin.headers })
  score.check("the seeded accounts list answers", seeded.status === 200, `total=${seeded.body.total}`)
  const seededTotal = seeded.body.total

  const pool = new pg.Pool({ connectionString: dbUrl, max: 1 })
  const plantedAt = Date.now()
  await pool.query(
    `INSERT INTO "account"."accounts" (id, type, created_at, deleted, version, body)
     SELECT 'acc-p' || lpad(g::text, 7, '0'), 'Account', now() - (g || ' seconds')::interval, false, 1,
            jsonb_build_object(
              'username', 'user-' || lpad(g::text, 6, '0'),
              'displayName', 'User ' || lpad(g::text, 6, '0'),
              'email', 'u' || lpad(g::text, 6, '0') || '@example.test',
              'roles', jsonb_build_array('reader'),
              'passwordHash', 'x')
     FROM generate_series(0, ${ROWS - 1}) g`,
  )
  const plantMs = Date.now() - plantedAt
  const counted = await pool.query(`SELECT count(*)::int AS c FROM "account"."accounts"`)
  score.check(
    `${ROWS} rows are on the table`,
    counted.rows[0].c === ROWS + seededTotal,
    `count=${counted.rows[0].c} planted in ${plantMs}ms`,
  )
  const total = ROWS + seededTotal

  const get = async (query) => await api.call(`/account${query}`, { headers: admin.headers })
  const timed = async (title, query) => {
    const started = Date.now()
    const r = await get(query)
    const ms = Date.now() - started
    timings.push(
      `${title.padEnd(46)} ${String(ms).padStart(6)} ms   ${query.length > 60 ? `${query.slice(0, 57)}...` : query}`,
    )
    return { r, ms }
  }

  // --- paging ---
  const first = await get("?page=1&pageSize=200&sort=username")
  score.check(
    "page 1 of 200 returns 200 rows and the true total",
    first.body.rows?.length === 200 && first.body.total === total,
    `rows=${first.body.rows?.length} total=${first.body.total}`,
  )

  const deep = await get("?page=300&pageSize=200&sort=username")
  score.check(
    "page 300 of 200 lands where it should, 59,800 rows in",
    // The two seeded accounts sort before every planted one, so the row at offset 59,800 is
    // the planted user two places earlier than the round number.
    deep.body.rows?.length === 200 && deep.body.rows[0].username === name(59_800 - seededTotal),
    `first=${deep.body.rows?.[0]?.username}`,
  )

  const past = await get("?page=400&pageSize=200")
  score.check(
    "past the end is an empty page with the total still counted",
    past.status === 200 && past.body.rows?.length === 0 && past.body.total === total,
  )

  const capped = await get("?pageSize=5000")
  score.check(
    "pageSize is capped at 200 rather than refused",
    capped.status === 200 && capped.body.rows?.length === 200 && capped.body.limit === 200,
    `rows=${capped.body.rows?.length} limit=${capped.body.limit}`,
  )

  // --- ordering ---
  const desc = await get("?sort=username:desc&pageSize=1")
  score.check(
    "sort=field:desc orders by that field, descending",
    desc.body.rows?.[0]?.username === name(ROWS - 1) && desc.body.sortedBy === "username",
    `first=${desc.body.rows?.[0]?.username}`,
  )

  const rejected = await get("?sort=user name")
  score.check("a malformed sort is refused, not ignored", rejected.status === 400, `status=${rejected.status}`)

  // --- filtering ---
  const exact = await get(`?username=${name(42_000)}&pageSize=5`)
  score.check(
    "an exact field filter matches one row out of 60,000",
    exact.body.total === 1 && exact.body.rows?.[0]?.username === name(42_000),
    `total=${exact.body.total}`,
  )

  const prefix = await get("?q=user-0042&pageSize=5")
  score.check(
    "q is a prefix match over the searchable fields, and the total counts the matches",
    prefix.body.total === 100 && prefix.body.rows?.every((r) => r.username.startsWith("user-0042")),
    `total=${prefix.body.total}`,
  )

  const other = await get("?q=u004200@example&pageSize=5")
  score.check(
    "q scans every searchable field, not just the first",
    other.body.total === 1 && other.body.rows?.[0]?.username === name(4200),
    `total=${other.body.total}`,
  )

  const literal = await get("?q=user-0042%25&pageSize=5")
  score.check(
    "a % in the search text is a character, not a wildcard",
    literal.body.total === 0,
    `total=${literal.body.total}`,
  )

  const combined = await get("?q=user-0042&email=u004200@example.test&pageSize=200")
  score.check("filters combine into one query", combined.body.total === 1, `total=${combined.body.total}`)

  const undeclared = await get("?passwordHash=x&somethingElse=1")
  score.check(
    "a field the manifest does not declare filters nothing",
    undeclared.body.total === total,
    `total=${undeclared.body.total}`,
  )

  const hashLeak = await get("?pageSize=1")
  score.check(
    "a filterable list still publishes no password hash",
    hashLeak.body.rows?.[0] !== undefined && !("passwordHash" in hashLeak.body.rows[0]),
  )

  // --- ids ---
  const wanted = [name(7), name(42_000), name(59_999)].map((u) => `acc-p${u.slice(5).padStart(7, "0")}`)
  const batch = await get(`?ids=${wanted.join(",")}`)
  score.check(
    "ids= returns exactly the rows asked for, in one request",
    batch.body.total === 3 &&
      [...(batch.body.rows ?? [])]
        .map((r) => r.id)
        .sort()
        .join(",") === [...wanted].sort().join(","),
    `total=${batch.body.total}`,
  )

  const many = Array.from({ length: 150 }, (_, i) => `acc-p${String(i * 391).padStart(7, "0")}`)
  const bigBatch = await get(`?ids=${many.join(",")}`)
  score.check(
    "a batch of 150 ids comes back whole, without asking for a page size",
    bigBatch.body.rows?.length === 150 && bigBatch.body.total === 150,
    `rows=${bigBatch.body.rows?.length} total=${bigBatch.body.total}`,
  )

  // --- in the database, not in memory ---
  //
  // The two questions that decide it. If the filter ran in JavaScript, `total` could only be
  // right after reading all 60,000 rows -- so a right total with a one-row page, answered fast,
  // is the proof. And if paging ran in memory, a deep page would cost the whole table.
  const filteredCount = await get(`?username=${name(42_000)}&pageSize=1`)
  score.check(
    "a filtered total is exact while the page holds one row -- the WHERE ran in Postgres",
    filteredCount.body.total === 1 && filteredCount.body.rows?.length === 1,
  )

  await timed("warm-up", "?page=1&pageSize=200&sort=username")
  const shallow = await timed("page 1 of 200, sorted", "?page=1&pageSize=200&sort=username")
  const deepest = await timed("page 300 of 200, sorted (offset 59800)", "?page=300&pageSize=200&sort=username")
  const unsorted = await timed("page 300 of 200, default order", "?page=300&pageSize=200")
  const filtered = await timed("one exact match out of 60,000", `?username=${name(42_000)}&pageSize=1`)
  const searched = await timed("prefix search, 100 matches", "?q=user-0042&pageSize=25")
  const idBatch = await timed("150 ids in one request", `?ids=${many.join(",")}`)
  const plainCount = await timed("first page, no filter, no sort", "?pageSize=25")

  score.check(
    "a deep page costs the same order as a shallow one",
    deepest.ms < Math.max(250, shallow.ms * 4),
    `page 1 ${shallow.ms}ms vs page 300 ${deepest.ms}ms`,
  )
  score.check(
    "every list answer is under a second on 60,000 rows",
    [shallow, deepest, unsorted, filtered, searched, idBatch, plainCount].every((t) => t.ms < 1000),
    `slowest ${Math.max(shallow.ms, deepest.ms, unsorted.ms, filtered.ms, searched.ms, idBatch.ms, plainCount.ms)}ms`,
  )

  // --- the contract is published, so the frontend stops guessing ---
  const meta = await api.call("/catalog/account/metadata", { headers: admin.headers })
  const list = meta.body?.list
  score.check(
    "the metadata publishes the list contract the kernel actually serves",
    list?.maxPageSize === 200 &&
      list?.defaultPageSize === 25 &&
      list?.totalIsExact === true &&
      [...(list?.filters ?? [])].sort().join(",") === "displayName,email,username" &&
      (list?.params ?? []).includes("ids"),
    `list=${JSON.stringify(list)}`,
  )

  // --- the same handler, a cube whose rows are permission-filtered ---
  //
  // `booktags/tags` goes through the entity-permission wrapper, which re-pages in memory after
  // filtering row by row (that filter cannot be SQL). The point here is that the CONTRACT is the
  // same anyway: the same parameter names mean the same things.
  await api.call("/tags", { headers: admin.headers })
  const tagPool = new pg.Pool({ connectionString: dbUrl, max: 1 })
  await tagPool.query(
    `INSERT INTO "booktags--tags"."tags" (id, type, created_at, deleted, version, body)
     SELECT 'tag-' || lpad(g::text, 6, '0'), 'Tag', now(), false, 1,
            jsonb_build_object('label', 'tag-' || lpad(g::text, 6, '0'), 'bookmarkId', 'bm-' || (g % ${GROUPS}))
     FROM generate_series(0, 499) g`,
  )
  await tagPool.end()
  await pool.end()

  const tagPage = await api.call("/tags?page=2&pageSize=10&sort=label", { headers: admin.headers })
  score.check(
    "page and pageSize mean the same thing on a permission-filtered cube",
    tagPage.body.rows?.length === 10 && tagPage.body.offset === 10 && tagPage.body.limit === 10,
    `rows=${tagPage.body.rows?.length} offset=${tagPage.body.offset} limit=${tagPage.body.limit}`,
  )
  const tagFilter = await api.call("/tags?bookmarkId=bm-3&pageSize=5", { headers: admin.headers })
  score.check(
    "a relation field filters there too, and the filter is the SQL one",
    tagFilter.body.total === 50 && tagFilter.body.rows?.every((r) => r.bookmarkId === "bm-3"),
    `total=${tagFilter.body.total}`,
  )
  const tagIds = await api.call("/tags?ids=tag-000001,tag-000002", { headers: admin.headers })
  score.check("ids= works there too", tagIds.body.total === 2, `total=${tagIds.body.total}`)

  console.log("\n  timings, 60,000 rows, no index on any filtered field:")
  for (const line of timings) console.log(`    ${line}`)

  failed = score.report("Generic list probe")
} catch (error) {
  console.error(error)
  console.error("--- server output ---")
  console.error(server.output)
  failed = 1
} finally {
  await stopServer(server)
  await dropDatabase(dbUrl)
  dropScratch(data)
}

process.exit(failed)
