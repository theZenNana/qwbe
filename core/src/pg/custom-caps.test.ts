// QWB-54 ticket 05, defects 2 and 5, measured against a real Postgres.
//
//   - defect 2: the custom caps apply to the MERGE result (the store is the last application
//     door a PATCH goes through) AND to the database itself, as a CHECK constraint every cube
//     table carries, backed by the 0002 migration's key-count function. The limit exists even
//     without the application.
//   - defect 5: one row's custom values are read by primary key. The evidence is a
//     measurement, not a reading of the code: Postgres' own tuple counters decide. The scan
//     control at the end proves the metric would catch a full walk if there were one.
//
// Each run gets a fresh throwaway database (the store.test.ts pattern); PG on :5433 must be up.

import assert from "node:assert/strict"
import { describe, it, layer } from "@effect/vitest"
import { Cause, Effect } from "effect"

import { customRowById, customRows } from "./custom-rows.ts"
import { CustomCapError } from "./errors.ts"
import { mergeCustom } from "./rows.ts"
import { withRole } from "./setup.ts"
import { storeFor } from "./store.ts"
import { testStore, withSql } from "./test-db.ts"

const store = storeFor("capcheck", ["items"])

const body = (custom: Record<string, unknown>): Record<string, unknown> => ({
  id: "itm-1",
  type: "Item",
  createdAt: "2026-08-31T00:00:00.000Z",
  deleted: false,
  name: "row",
  custom,
})

const currentRow = (custom: Record<string, unknown>): Record<string, unknown> => ({
  id: "itm-1",
  type: "Item",
  created_at: "2026-08-31T00:00:00.000Z",
  deleted: false,
  version: 1,
  body: { name: "row", custom },
})

const keys = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, "x"]))

const tuplesRead = (schema: string, table: string) =>
  Effect.gen(function* () {
    // Counters are flushed to shared memory lazily; force it so the measurement sees the reads
    // the calls above just made.
    yield* withSql((sql) => sql`SELECT pg_stat_force_next_flush()`)
    const [r] = yield* withSql(
      (sql) => sql<{ read: number }>`SELECT coalesce(sum(seq_tup_read + idx_tup_fetch), 0)::int AS read
                                     FROM pg_stat_user_tables WHERE schemaname = ${schema} AND relname = ${table}`,
    )
    return r?.read ?? 0
  })

describe("the custom caps on the merge (ticket 05, defect 2)", () => {
  it("a merge that lands past the key cap is refused", () => {
    assert.throws(() => mergeCustom(currentRow(keys(32)), { ...body({}), custom: { f32: "x" } }), CustomCapError)
  })

  it("a merge that lands exactly on the cap still merges", () => {
    const merged = mergeCustom(currentRow(keys(31)), { ...body({}), custom: { f31: "x" } })
    assert.equal(Object.keys(merged.custom as Record<string, unknown>).length, 32)
  })

  it("the merged result respects the byte cap too", () => {
    assert.throws(
      () => mergeCustom(currentRow({ a: "x".repeat(5000) }), { ...body({}), custom: { b: "x".repeat(5000) } }),
      CustomCapError,
    )
  })
})

// The database and the store live in the layer's scope: closing it closes the pool and drops the
// database, even when the setup itself failed half-way.
layer(testStore("customcaps"), { timeout: 60_000, excludeTestServices: true })("custom caps on Postgres", (it) => {
  describe("the caps as a Postgres CHECK (ticket 05, defect 2)", () => {
    it.effect("a row past the key cap cannot be written, with or without the application", () =>
      Effect.gen(function* () {
        const inserted = yield* store.insert("items", "Item", "itm", { name: "seed" })
        const setCustom = (n: number) =>
          withSql((sql) =>
            withRole(
              "capcheck",
              sql`UPDATE "capcheck"."items" SET body = jsonb_set(body, '{custom}', ${JSON.stringify(keys(n))})
                  WHERE id = ${inserted.id}`,
            ).pipe(Effect.mapError((e) => (e.cause instanceof Error ? e.cause : e))),
          )
        // 32 keys: legal everywhere.
        yield* setCustom(32)
        // The 33rd key, written straight into the database as if the application were absent:
        // Postgres refuses on its own.
        assert.match(Cause.pretty(yield* Effect.flip(Effect.sandbox(setCustom(33)))), /custom_caps/)
      }),
    )
  })

  describe("one row's values are read by primary key (ticket 05, defect 5)", () => {
    it.effect("measured: one lookup reads a handful of tuples, a scan reads them all", () =>
      Effect.gen(function* () {
        for (let i = 0; i < 300; i++) {
          yield* store.insert("items", "Item", "itm", { name: `row-${i}`, custom: { tag: "x" } })
        }
        const all = yield* customRowById("capcheck", ["items"], "missing-on-purpose")
        assert.equal(all, undefined)
        const found = yield* store.page<{ id: string }>("items", { offset: 0, limit: 1 })
        const target = found.rows[0]!.id

        yield* withSql((sql) => sql`SELECT pg_stat_reset()`)
        const before = yield* tuplesRead("capcheck", "items")
        const row = yield* customRowById("capcheck", ["items"], target)
        const after = yield* tuplesRead("capcheck", "items")
        assert.equal(row?.id, target)
        const delta = after - before
        assert.ok(delta > 0, "the lookup must read at least the one row -- a zero reads means the metric is off")
        assert.ok(delta <= 5, `one lookup read ${delta} tuples of a 301-row table; a scan would read them all`)

        // The control: the full walk -- the orphan report's reader -- DOES read the table, so the
        // metric above is proven able to catch the old behavior. Measured, not assumed.
        yield* withSql((sql) => sql`SELECT pg_stat_reset()`)
        const scanBefore = yield* tuplesRead("capcheck", "items")
        yield* customRows("capcheck", ["items"])
        const scanAfter = yield* tuplesRead("capcheck", "items")
        assert.ok(
          scanAfter - scanBefore >= 300,
          `the full walk read only ${scanAfter - scanBefore} tuples -- the metric stopped working`,
        )
      }),
    )
  })
})
