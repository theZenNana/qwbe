// Unit tests for the Postgres-backed CubeStore (QWB-44). Each run gets a fresh database, so
// the assertions below can count rows and outbox entries exactly.
//
// The two new invariants this file pins down, beyond the operations the cubes already use:
//
//   1. a write that fails inside its transaction leaves NOTHING behind -- not the row, not
//      its outbox entry. This is the guarantee the SQLite store could not make (no
//      transactions) and the reason the store moved (ADR-0001 section 4).
//   2. every successful insert and update leaves EXACTLY ONE outbox row, with the right op
//      and the row's version after the write (ADR-0001 section 5).

import assert from "node:assert/strict"
import { layer } from "@effect/vitest"
import { Cause, Effect, Exit, Option } from "effect"
import { SORT_KEY_VERSION, sortKey } from "../kernel/sort-key.ts"
import { ensureCubeSchema, ensureTable, rekey, SetupLive, schemaName, withRole } from "./setup.ts"
import { storeFor } from "./store.ts"
import { testStore, withSql } from "./test-db.ts"

const store = storeFor("pgtest", ["items", "logs"], ["name"])
// Its own cube and table, so the lookups below count exactly what they inserted.
const lookups = storeFor("pglookup", ["people"], [], false, undefined, { people: ["username"] })
// Sort keys (Qwbe#73): one table per test, so each sees only its own rows.
const sorted = storeFor("pgsort", ["things", "keys", "backfill", "batched"], ["rank"], true)

// The store's operations are Effect values with a `never` error channel; a defect fails the test.
const outboxCount = Effect.map(
  withSql((sql) => sql<{ c: number }>`SELECT COUNT(*)::int AS c FROM qwbe.outbox`),
  ([r]) => r?.c ?? 0,
)

type Outbox = { op: string; version: number; row_id: string; cube: string; table: string }

const lastOutbox = Effect.map(
  withSql((sql) => sql<Outbox>`SELECT op, version, row_id, cube, "table" FROM qwbe.outbox ORDER BY id DESC LIMIT 1`),
  ([r]) => r,
)

// The database and the store live in the layer's scope: closing it closes the pool and drops the
// database, even when the setup itself failed half-way.
layer(testStore("store"), { timeout: 60_000, excludeTestServices: true })("CubeStore over Postgres", (it) => {
  it.effect("inserts, reads, pages, counts and updates like the old store", () =>
    Effect.gen(function* () {
      const a = (yield* store.insert("items", "item", "itm", { name: "a" })) as {
        id: string
        type: string
        deleted: boolean
      }
      const b = yield* store.insert("items", "item", "itm", { name: "b" })
      assert.match(a.id, /^itm-[0-9a-f]{32}$/)
      assert.equal(a.type, "item")
      assert.equal(a.deleted, false)
      assert.equal((yield* store.byId<{ name: string }>("items", a.id))?.name, "a")
      const page = yield* store.page<{ name: string }>("items", { offset: 0, limit: 1 })
      assert.equal(page.total, 2)
      assert.equal(page.rows.length, 1)
      assert.equal(page.sortedBy, "createdAt")
      assert.equal(yield* store.count("items"), 2)
      const updated = yield* store.update("items", b.id as string, { name: "b2" })
      assert.equal(updated?.name, "b2")
    }),
  )

  it.effect("sorts by a declared sortable field and ignores an undeclared one", () =>
    Effect.gen(function* () {
      yield* store.insert("logs", "log", "log", { name: "z" })
      yield* store.insert("logs", "log", "log", { name: "a" })
      const byName = yield* store.page<{ name: string }>("logs", { offset: 0, limit: 10, sortBy: "name" })
      assert.equal(byName.sortedBy, "name")
      assert.equal(byName.rows[0]?.name, "a")
      const refused = yield* store.page<{ name: string }>("logs", { offset: 0, limit: 10, sortBy: "secret" })
      assert.equal(refused.sortedBy, "createdAt")
    }),
  )

  it.effect("throws ForeignTableError for a table the cube does not own", () =>
    Effect.gen(function* () {
      // The check runs before any SQL is built, so the failure is the typed error itself.
      // The store is typed loosely enough that an undeclared table compiles; the RUNTIME
      // check is the one that must fire -- the whole point of ForeignTableError.
      const cause = yield* Effect.flip(Effect.sandbox(store.all("other-cube-data")))
      const e = Cause.squash(cause)
      assert.ok(e instanceof Error && /does not own/.test(e.message))
    }),
  )

  it.effect("rolls the whole transaction back: no row, no outbox entry", () =>
    Effect.gen(function* () {
      const before = yield* outboxCount
      const exit = yield* Effect.exit(
        withSql((sql) =>
          withRole(
            "pgtest",
            Effect.gen(function* () {
              const id = `itm-${Math.random().toString(16).slice(2, 10)}`
              yield* sql`INSERT INTO "pgtest"."items" (id, type, created_at, deleted, version, body)
                         VALUES (${id}, 'item', now(), false, 1, '{}')`
              yield* sql`INSERT INTO qwbe.outbox (cube, "table", row_id, op, version)
                         VALUES ('pgtest', 'items', ${id}, 'insert', 1)`
              return yield* Effect.fail(new Error("injected fault inside the transaction"))
            }),
          ),
        ),
      )
      assert.ok(Exit.isFailure(exit))
      // The injected insert used the same transaction as the store's writes do -- whatever the
      // transaction touched, the fault must have erased.
      const after = yield* outboxCount
      assert.equal(after, before, "the outbox row written by the failed transaction is gone")
    }),
  )

  it.effect("survives 8 concurrent first touches of one new cube (the DDL race)", () =>
    Effect.gen(function* () {
      // The reviewer measured 7 failures in 8 concurrent first touches before the fix: each
      // ran the whole DDL block and Postgres refused the duplicate schema creation. The
      // in-flight-promise memoization plus the advisory lock must make every one succeed.
      const burst = storeFor("pgrace", ["things"], [])
      const results = yield* Effect.all(
        Array.from({ length: 8 }, () => burst.insert("things", "thing", "thg", { n: 1 })),
        { concurrency: "unbounded" },
      )
      assert.equal(results.length, 8)
      assert.ok(results.every((r) => typeof r.id === "string"))
      assert.equal(yield* burst.count("things"), 8)
    }),
  )

  it.effect("survives 8 concurrent first touches of a table with indexed fields (the index DDL race)", () =>
    Effect.gen(function* () {
      // Each touch gets its own Setup memo, as two sessions or processes would: only the
      // advisory lock stands between their CREATE INDEX IF NOT EXISTS and a duplicate pg_class row.
      yield* withSql(() => ensureCubeSchema("pgidxrace"))
      const schema = schemaName("pgidxrace")
      yield* Effect.all(
        Array.from({ length: 8 }, () =>
          withSql(() => ensureTable(schema, "owners", ["entityType", "ownerId"]).pipe(Effect.provide(SetupLive))),
        ),
        { concurrency: "unbounded" },
      )
      const indexes = yield* withSql(
        (sql) => sql<{ n: string }>`SELECT indexname AS n FROM pg_indexes WHERE schemaname = ${schema}`,
      )
      assert.deepEqual(indexes.map((r) => r.n).sort(), [
        "owners_body_gin",
        "owners_entityType_idx",
        "owners_ownerId_idx",
        "owners_pkey",
      ])
    }),
  )

  it.effect("leaves exactly one outbox row per successful insert and update", () =>
    Effect.gen(function* () {
      const before = yield* outboxCount
      const row = yield* store.insert("items", "item", "itm", { name: "tracked" })
      assert.equal(yield* outboxCount, before + 1)
      let last = yield* lastOutbox
      assert.equal(last?.op, "insert")
      assert.equal(last?.version, 1)
      yield* store.update("items", row.id as string, { name: "tracked2" })
      assert.equal(yield* outboxCount, before + 2)
      last = yield* lastOutbox
      assert.equal(last?.op, "update")
      assert.equal(last?.version, 2)
      assert.equal(last?.row_id, row.id)
      assert.equal(last?.cube, "pgtest")
      assert.equal(last?.table, "items")
    }),
  )

  it.effect("first finds the oldest live match, or none", () =>
    Effect.gen(function* () {
      const a = yield* lookups.insert("people", "person", "per", { username: "ana", team: "red" })
      yield* lookups.insert("people", "person", "per", { username: "ana", team: "blue" })
      const hit = yield* lookups.first<{ id: string }>("people", { field: "username", value: "ana" })
      assert.equal(Option.getOrUndefined(hit)?.id, a.id)
      assert.ok(Option.isNone(yield* lookups.first("people", { field: "username", value: "nobody" })))
    }),
  )

  it.effect("where ANDs its conditions, filters a meta column on the column, and honours limit", () =>
    Effect.gen(function* () {
      const bo = yield* lookups.insert("people", "person", "per", { username: "bo", team: "red" })
      yield* lookups.insert("people", "person", "per", { username: "bo", team: "blue" })
      yield* lookups.insert("people", "person", "per", { username: "bo", team: "red" })
      assert.equal((yield* lookups.where("people", { field: "username", value: "bo" })).length, 3)
      const reds = yield* lookups.where<{ id: string }>("people", [
        { field: "username", value: "bo" },
        { field: "team", value: "red" },
      ])
      assert.equal(reds.length, 2)
      assert.equal(reds[0]?.id, bo.id, "oldest first")
      const byId = yield* lookups.where<{ id: string }>("people", { field: "id", value: String(bo.id) })
      assert.deepEqual(
        byId.map((r) => r.id),
        [bo.id],
      )
      assert.equal((yield* lookups.where("people", { field: "username", value: "bo" }, { limit: 2 })).length, 2)
    }),
  )

  it.effect("where keeps a body field in a set, and an empty set matches nothing", () =>
    Effect.gen(function* () {
      const dee = yield* lookups.insert("people", "person", "per", { username: "dee", team: "green" })
      const eve = yield* lookups.insert("people", "person", "per", { username: "eve", team: "green" })
      yield* lookups.insert("people", "person", "per", { username: "fay", team: "green" })
      const picked = yield* lookups.where<{ id: string }>("people", {
        equals: [{ field: "team", value: "green" }],
        in: [{ field: "username", values: ["dee", "eve", "nobody"] }],
      })
      assert.deepEqual(
        picked.map((r) => r.id),
        [dee.id, eve.id],
      )
      assert.equal((yield* lookups.where("people", { in: [{ field: "username", values: [] }] })).length, 0)
    }),
  )

  it.effect("pages rows with one created_at by id, never repeating or skipping one", () =>
    Effect.gen(function* () {
      const paged = storeFor("pgties", ["ties"], [])
      yield* paged.count("ties")
      // One statement, so every row gets the same now(): created_at ties on all of them.
      yield* withSql(
        (sql) => sql`INSERT INTO "pgties"."ties" (id, type, created_at, deleted, version, body)
                     SELECT 'r-' || lpad(n::text, 3, '0'), 'row', now(), false, 1, '{}'
                     FROM generate_series(1, 30) AS n`,
      )
      for (const descending of [false, true]) {
        const seen: Array<string> = []
        for (let offset = 0; offset < 30; offset += 7) {
          const page = yield* paged.page<{ id: string }>("ties", { offset, limit: 7, descending })
          seen.push(...page.rows.map((r) => r.id))
        }
        const ids = Array.from({ length: 30 }, (_, i) => `r-${String(i + 1).padStart(3, "0")}`)
        assert.deepEqual(seen, descending ? ids.reverse() : ids)
      }
    }),
  )

  it.effect("where ORs anyOf groups and drops a not group, keeping a row missing its field", () =>
    Effect.gen(function* () {
      const gus = yield* lookups.insert("people", "person", "per", { username: "gus", team: "violet" })
      const hal = yield* lookups.insert("people", "person", "per", { username: "hal", team: "violet" })
      const ivy = yield* lookups.insert("people", "person", "per", { username: "ivy" })
      const ids = (rows: ReadonlyArray<{ id: string }>) => rows.map((r) => r.id)
      const either = yield* lookups.where<{ id: string }>("people", {
        anyOf: [{ equals: [{ field: "username", value: "gus" }] }, { ids: [String(ivy.id)] }],
      })
      assert.deepEqual(ids(either), [gus.id, ivy.id])
      assert.equal((yield* lookups.where("people", { anyOf: [] })).length, 0)
      const notHal = yield* lookups.where<{ id: string }>("people", {
        in: [{ field: "id", values: [String(gus.id), String(hal.id), String(ivy.id)] }],
        not: {
          equals: [
            { field: "team", value: "violet" },
            { field: "username", value: "hal" },
          ],
        },
      })
      assert.deepEqual(ids(notHal), [gus.id, ivy.id])
    }),
  )

  it.effect("leaves soft-deleted rows out of first and where", () =>
    Effect.gen(function* () {
      const gone = yield* lookups.insert("people", "person", "per", { username: "cy" })
      yield* lookups.update("people", String(gone.id), { deleted: true })
      assert.ok(Option.isNone(yield* lookups.first("people", { field: "username", value: "cy" })))
      assert.equal((yield* lookups.where("people", { field: "username", value: "cy" })).length, 0)
    }),
  )

  it.effect("creates the declared lookup index on the first access of the table", () =>
    Effect.gen(function* () {
      yield* lookups.count("people")
      const found = yield* withSql(
        (sql) => sql<{ indexname: string }>`SELECT indexname FROM pg_indexes
                                            WHERE schemaname = ${schemaName("pglookup")} AND tablename = 'people'`,
      )
      assert.ok(found.some((r) => r.indexname === "people_username_idx"))
    }),
  )

  // Qwbe#73: list order comes from kernel/sort-key.ts, not from the engine. A page equals the
  // same rows sorted in memory by their keys, then id; a missing field sits before a null.
  it.effect("pages in the order of the application's sort keys, both directions, with ties", () =>
    Effect.gen(function* () {
      const values = [10, 9, -1.5, 0, 10, "b", "B", "\u00c9mile", "emile", "a", null, true, false, undefined, 9]
      for (const rank of values) yield* sorted.insert("things", "thing", "thg", rank === undefined ? {} : { rank })
      const all = yield* sorted.page<{ id: string; rank?: unknown }>("things", { offset: 0, limit: 100 })
      const key = (r: { rank?: unknown }) => (r.rank === undefined ? "" : sortKey(r.rank))
      const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
      const ascending = [...all.rows].sort((a, b) => cmp(key(a), key(b)) || cmp(a.id, b.id)).map((r) => r.id)
      const ids = (descending: boolean) =>
        Effect.map(sorted.page<{ id: string }>("things", { offset: 0, limit: 100, sortBy: "rank", descending }), (p) =>
          p.rows.map((r) => r.id),
        )
      assert.equal(all.total, values.length)
      assert.deepEqual(yield* ids(false), ascending)
      assert.deepEqual(yield* ids(true), [...ascending].reverse())
    }),
  )

  it.effect("writes the keys with the body, rewrites them on update and never returns them", () =>
    Effect.gen(function* () {
      const row = yield* sorted.insert("keys", "thing", "thg", { rank: 2, _sort: "forged" })
      assert.equal("_sort" in row, false)
      const stored = Effect.map(
        withSql((sql) => sql<{ s: unknown }>`SELECT body -> '_sort' AS s FROM "pgsort"."keys" WHERE id = ${row.id}`),
        ([r]) => r?.s,
      )
      assert.deepEqual(yield* stored, { v: SORT_KEY_VERSION, k: { rank: sortKey(2) } })
      const updated = yield* sorted.update("keys", String(row.id), { rank: "x", _sort: "forged" })
      assert.equal(updated !== undefined && "_sort" in updated, false)
      assert.deepEqual(yield* stored, { v: SORT_KEY_VERSION, k: { rank: sortKey("x") } })
      assert.equal("_sort" in ((yield* sorted.byId<Record<string, unknown>>("keys", String(row.id))) ?? {}), false)
    }),
  )

  it.effect("backfills missing and old keys, and a second run changes nothing", () =>
    Effect.gen(function* () {
      const a = yield* sorted.insert("backfill", "thing", "thg", { rank: 1 })
      const b = yield* sorted.insert("backfill", "thing", "thg", { rank: "z" })
      const c = yield* sorted.insert("backfill", "thing", "thg", { other: 1 })
      const bodies = withSql(
        (sql) =>
          sql<{ id: string; body: Record<string, unknown> }>`SELECT id, body FROM "pgsort"."backfill" ORDER BY id`,
      )
      const before = yield* bodies
      yield* withSql((sql) =>
        Effect.all([
          sql`UPDATE "pgsort"."backfill" SET body = body - '_sort' WHERE id = ${String(a.id)}`,
          sql`UPDATE "pgsort"."backfill" SET body = jsonb_set(body, '{_sort,v}', '0') WHERE id = ${String(b.id)}`,
        ]),
      )
      yield* withSql((sql) => rekey(sql, sql`"pgsort"."backfill"`, ["rank"]))
      assert.deepEqual(yield* bodies, before)
      yield* withSql((sql) => rekey(sql, sql`"pgsort"."backfill"`, ["rank"]))
      assert.deepEqual(yield* bodies, before)
      assert.equal(before.find((r) => r.id === c.id)?.body._sort, undefined, "no sortable field, no keys")
    }),
  )

  it.effect("rekeys the rows a raw batch changed, in the same transaction", () =>
    Effect.gen(function* () {
      const low = yield* sorted.insert("batched", "thing", "thg", { rank: 1 })
      const high = yield* sorted.insert("batched", "thing", "thg", { rank: 2 })
      const batch = sorted.batch
      assert.ok(batch)
      yield* batch([
        { text: `UPDATE "batched" SET body = jsonb_set(body, '{rank}', '3') WHERE id = $1`, values: [low.id] },
      ])
      const page = yield* sorted.page<{ id: string }>("batched", { offset: 0, limit: 10, sortBy: "rank" })
      assert.deepEqual(
        page.rows.map((r) => r.id),
        [high.id, low.id],
      )
    }),
  )
})
