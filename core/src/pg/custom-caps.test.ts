// QWB-54 ticket 05, defects 2 and 5, measured against a real Postgres.
//
//   - defect 2: the custom caps apply to the MERGE result (the store is the last application
//     door a PATCH goes through) AND to the database itself, as a CHECK constraint every cube
//     table carries, backed by the 0002 migration's key-count function. The limit exists even
//     without the application.
//   - defect 5: one row's custom values are read with `WHERE id = $1`. The evidence is a
//     measurement, not a reading of the code: Postgres' own tuple counters decide. The scan
//     control at the end proves the metric would catch a full walk if there were one.
//
// Each run gets a fresh throwaway database (the store.test.ts pattern); PG on :5433 must be up.

import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { Effect } from "effect"

import { createTestDatabase } from "./test-db.ts"

const db = await createTestDatabase("customcaps")
process.env.QWBE_DATABASE_URL = db.url

const { initStore, closeAll } = await import("../kernel/store.ts")
const { storeFor } = await import("./store.ts")
const { mergeCustom } = await import("./rows.ts")
const { customRowById, customRows } = await import("./custom-rows.ts")
const { withRole } = await import("./setup.ts")
const { getPool } = await import("./db.ts")
const { CustomCapError } = await import("./errors.ts")

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

const tuplesRead = async (schema: string, table: string): Promise<number> => {
  // Counters are flushed to shared memory lazily; force it so the measurement sees the reads
  // the calls above just made.
  await getPool().query("SELECT pg_stat_force_next_flush()")
  const r = await getPool().query(
    `SELECT coalesce(sum(seq_tup_read + idx_tup_fetch), 0)::int AS read
     FROM pg_stat_user_tables WHERE schemaname = $1 AND relname = $2`,
    [schema, table],
  )
  return (r.rows[0] as { read: number }).read
}

before(async () => {
  await closeAll()
  await initStore()
})

after(async () => {
  await closeAll()
  await db.drop()
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

describe("the caps as a Postgres CHECK (ticket 05, defect 2)", () => {
  it("a row past the key cap cannot be written, with or without the application", async () => {
    const inserted = (await Effect_run(store.insert("items", "Item", "itm", { name: "seed" }))) as { id: string }
    await withRole("capcheck", async (c) => {
      // 32 keys: legal everywhere.
      await c.query(`UPDATE "capcheck"."items" SET body = jsonb_set(body, '{custom}', $1) WHERE id = $2`, [
        JSON.stringify(keys(32)),
        inserted.id,
      ])
      // The 33rd key, written straight into the database as if the application were absent:
      // Postgres refuses on its own.
      await assert.rejects(
        c.query(`UPDATE "capcheck"."items" SET body = jsonb_set(body, '{custom}', $1) WHERE id = $2`, [
          JSON.stringify(keys(33)),
          inserted.id,
        ]),
        /custom_caps/,
      )
    })
  })
})

describe("one row's values are read with WHERE id = $1 (ticket 05, defect 5)", () => {
  it("measured: one lookup reads a handful of tuples, a scan reads them all", async () => {
    for (let i = 0; i < 300; i++) {
      await Effect_run(store.insert("items", "Item", "itm", { name: `row-${i}`, custom: { tag: "x" } }))
    }
    const all = await Effect_run(customRowById("capcheck", ["items"], "missing-on-purpose"))
    assert.equal(all, undefined)
    const found = await Effect_run(store.page<{ id: string }>("items", { offset: 0, limit: 1 }))
    const target = found.rows[0]!.id

    await getPool().query("SELECT pg_stat_reset()")
    const before = await tuplesRead("capcheck", "items")
    const row = await Effect_run(customRowById("capcheck", ["items"], target))
    const after = await tuplesRead("capcheck", "items")
    assert.equal(row?.id, target)
    const delta = after - before
    assert.ok(delta > 0, "the lookup must read at least the one row -- a zero reads means the metric is off")
    assert.ok(delta <= 5, `one lookup read ${delta} tuples of a 301-row table; a scan would read them all`)

    // The control: the full walk -- the orphan report's reader -- DOES read the table, so the
    // metric above is proven able to catch the old behavior. Measured, not assumed.
    await getPool().query("SELECT pg_stat_reset()")
    const scanBefore = await tuplesRead("capcheck", "items")
    await Effect_run(customRows("capcheck", ["items"]))
    const scanAfter = await tuplesRead("capcheck", "items")
    assert.ok(
      scanAfter - scanBefore >= 300,
      `the full walk read only ${scanAfter - scanBefore} tuples -- the metric stopped working`,
    )
  })
})

const Effect_run = async <T>(effect: Effect.Effect<T, never, never>): Promise<T> =>
  (await Effect.runPromise(effect)) as T
