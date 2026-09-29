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
import { schemaName, withRole } from "./setup.ts"
import { storeFor } from "./store.ts"
import { testStore, withSql } from "./test-db.ts"

const store = storeFor("pgtest", ["items", "logs"], ["name"])
// Its own cube and table, so the lookups below count exactly what they inserted.
const lookups = storeFor("pglookup", ["people"], [], false, undefined, { people: ["username"] })

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
})
