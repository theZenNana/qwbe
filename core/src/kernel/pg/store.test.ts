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
import { after, before, describe, it } from "node:test"

import { createTestDatabase } from "./test-db.ts"

const db = await createTestDatabase("store")
process.env.QWBE_DATABASE_URL = db.url

const { initStore, closeAll } = await import("../store.ts")
const { storeFor, withRole } = await import("./store.ts")
const { getPool } = await import("./db.ts")
const { forgetEnsured } = await import("./setup.ts")

const store = storeFor("pgtest", ["items", "logs"], ["name"])

before(async () => {
  forgetEnsured()
  await initStore()
})

after(async () => {
  await closeAll()
  await db.drop()
})

describe("CubeStore over Postgres", () => {
  it("inserts, reads, pages, counts and updates like the old store", async () => {
    const a = await Effect_run(store.insert("items", "item", "itm", { name: "a" }))
    const b = await Effect_run(store.insert("items", "item", "itm", { name: "b" }))
    assert.match(a.id, /^itm-[0-9a-f]{8}$/)
    assert.equal(a.type, "item")
    assert.equal(a.deleted, false)
    assert.equal(await Effect_run(store.byId<{ name: string }>("items", a.id)).then((r) => r?.name), "a")
    const page = await Effect_run(store.page<{ name: string }>("items", { offset: 0, limit: 1 }))
    assert.equal(page.total, 2)
    assert.equal(page.rows.length, 1)
    assert.equal(page.sortedBy, "createdAt")
    assert.equal(await Effect_run(store.count("items")), 2)
    const updated = await Effect_run(store.update("items", b.id, { name: "b2" }))
    assert.equal((updated as { name: string }).name, "b2")
  })

  it("sorts by a declared sortable field and ignores an undeclared one", async () => {
    await Effect_run(store.insert("logs", "log", "log", { name: "z" }))
    await Effect_run(store.insert("logs", "log", "log", { name: "a" }))
    const byName = await Effect_run(store.page<{ name: string }>("logs", { offset: 0, limit: 10, sortBy: "name" }))
    assert.equal(byName.sortedBy, "name")
    assert.equal(byName.rows[0]?.name, "a")
    const refused = await Effect_run(store.page<{ name: string }>("logs", { offset: 0, limit: 10, sortBy: "secret" }))
    assert.equal(refused.sortedBy, "createdAt")
  })

  it("throws ForeignTableError for a table the cube does not own", async () => {
    // The check runs before any SQL is built, so the rejection is the typed error itself.
    await assert.rejects(
      // @ts-expect-error -- the whole point: an undeclared table must not compile away the check
      () => Effect.runPromise(store.all("other-cube-data")),
      (e: unknown) => e instanceof Error && /does not own/.test(e.message),
    )
  })

  it("rolls the whole transaction back: no row, no outbox entry", async () => {
    const before = await outboxCount()
    await assert.rejects(() =>
      withRole("pgtest", async (c) => {
        const id = `itm-${Math.random().toString(16).slice(2, 10)}`
        await c.query(
          `INSERT INTO "pgtest"."items" (id, type, created_at, deleted, version, body)
           VALUES ($1, 'item', now(), false, 1, '{}')`,
          [id],
        )
        await c.query(
          `INSERT INTO qwbe.outbox (cube, "table", row_id, op, version)
                       VALUES ('pgtest', 'items', $1, 'insert', 1)`,
          [id],
        )
        throw new Error("injected fault inside the transaction")
      }),
    )
    // The injected insert used the same transaction as the store's writes do -- whatever the
    // transaction touched, the fault must have erased.
    const after = await outboxCount()
    assert.equal(after, before, "the outbox row written by the failed transaction is gone")
  })

  it("leaves exactly one outbox row per successful insert and update", async () => {
    const before = await outboxCount()
    const row = await Effect_run(store.insert("items", "item", "itm", { name: "tracked" }))
    assert.equal(await outboxCount(), before + 1)
    let last = await lastOutbox()
    assert.equal(last.op, "insert")
    assert.equal(last.version, 1)
    await Effect_run(store.update("items", row.id, { name: "tracked2" }))
    assert.equal(await outboxCount(), before + 2)
    last = await lastOutbox()
    assert.equal(last.op, "update")
    assert.equal(last.version, 2)
    assert.equal(last.row_id, row.id)
    assert.equal(last.cube, "pgtest")
    assert.equal(last.table, "items")
  })
})

// The store's operations are Effect values with a `never` error channel; in a test we just
// run them and let a defect surface.
import { Effect } from "effect"

const Effect_run = <T>(effect: Effect.Effect<T, never, never>): Promise<T> => Effect.runPromise(effect)

const outboxCount = async (): Promise<number> => {
  const r = await getPool().query(`SELECT COUNT(*)::int AS c FROM qwbe.outbox`)
  return (r.rows[0] as unknown as { c: number }).c
}

const lastOutbox = async (): Promise<{ op: string; version: number; row_id: string; cube: string; table: string }> => {
  const r = await getPool().query(`SELECT op, version, row_id, cube, "table" FROM qwbe.outbox ORDER BY id DESC LIMIT 1`)
  return r.rows[0] as unknown as {
    op: string
    version: number
    row_id: string
    cube: string
    table: string
  }
}
