// Echo (activity log + comments) against a REAL Postgres. Same harness as store.test.ts:
// one throwaway database per run, env set before the store modules load, `node --test`.
//
// What only a real database can prove, and what this file pins down:
//   1. the reader role is created by the FIRST activity call on a fresh database (B1);
//   2. a plain cube role cannot read the log or the comments;
//   3. capture follows the declared entity type exactly; auxiliary rows are invisible to
//      capture and to `rowStateFor`, and deleted/restored is read from the CURRENT row;
//   4. atomicity, exercised through the real `store.insert`, `store.update` and
//      `comments.add`: when the activity INSERT fails, the business row / comment row and
//      every counter are exactly as before. The failure is forced by a test-only trigger on
//      `qwbe.activity` (installed here, lives only in this database) -- not by a hand-rolled
//      transaction that never touches the implementation.
//
// Safety: roles are cluster-wide and survive DROP DATABASE, so cube names carry a per-run
// tag and role/schema names come from the real `roleName(schemaName(...))`. The helper's
// default target is the long-lived compose server on 5433; this file refuses to run unless
// the port is named explicitly (or the default is opted into), so a bare invocation cannot
// reach a live server by accident.

import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { after, before, describe, it } from "node:test"
import { Effect } from "effect"

import { createTestDatabase } from "./test-db.ts"

if (process.env.QWBE_PG_PORT === undefined && process.env.QWBE_PG_ALLOW_DEFAULT !== "1") {
  throw new Error(
    "echo-activity-pg.test.ts: set QWBE_PG_PORT to an isolated Postgres (see .pi/echo-pg-verification-plan.md) " +
      "or QWBE_PG_ALLOW_DEFAULT=1 to accept the helper default (localhost:5433)",
  )
}

const db = await createTestDatabase("echo")
process.env.QWBE_DATABASE_URL = db.url

const { initStore, closeAll } = await import("../kernel/store.ts")
const { storeFor, rowStateFor } = await import("./store.ts")
const { activityToolsFor } = await import("./activity.ts")
const { roleName, schemaName, withRole } = await import("./setup.ts")
const { getPool } = await import("./db.ts")
const { CurrentActor } = await import("../kernel/actor.ts")

type Actor = { readonly id: string; readonly username: string }

// Per-run names: roles are cluster-wide, a sibling run (or a stale role) must never collide.
const tag = randomBytes(3).toString("hex")
const echoCube = `echo_${tag}`
const notesCube = `notes_${tag}`
const readerRole = roleName(schemaName(echoCube))
const notesRole = roleName(schemaName(notesCube))
const notesSchema = schemaName(notesCube)

const ana: Actor = { id: "u-ana", username: "ana" }
const bob: Actor = { id: "u-bob", username: "bob" }

const run = async <T>(effect: Effect.Effect<T, never, never>): Promise<T> => (await Effect.runPromise(effect)) as T
const as = <T>(actor: Actor, effect: Effect.Effect<T, never, never>): Effect.Effect<T, never, never> =>
  Effect.locally(effect, CurrentActor, actor)

// "notes" is the declared entity table (captureEntity "Note"); "tags" is auxiliary.
const notes = storeFor(notesCube, ["notes", "tags"], [], false, "Note")
const echo = activityToolsFor(echoCube)
const state = rowStateFor(notesCube, ["notes", "tags"], "Note")

const count = async (sql: string): Promise<number> =>
  ((await getPool().query(`SELECT COUNT(*)::int AS c FROM ${sql}`)).rows[0] as { c: number }).c
const counts = async () => ({
  activity: await count("qwbe.activity"),
  comment: await count("qwbe.comment"),
  outbox: await count("qwbe.outbox"),
  notes: await count(`"${notesSchema}"."notes"`),
})
const roleExists = async (role: string): Promise<boolean> =>
  ((await getPool().query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role])).rowCount ?? 0) === 1

before(async () => {
  await closeAll()
  await initStore()
  // Schema and tables are created lazily by the first store operation (ensureCubeSchema
  // creates only the schema and role; ensureTable creates the table). The `counts()` helper
  // reads the notes table with raw SQL, so warm it through the real read path first. A fresh
  // database must answer 0. This touches the notes cube only: the echo reader role is still
  // created by test 1, as it asserts.
  assert.equal(await run(notes.count("notes")), 0, "fresh database: notes table must start empty")
  // Test fixture ONLY: forces the activity INSERT to fail on demand, so the negative
  // atomicity cases go through the real store and comment code paths.
  await getPool().query(`
    CREATE FUNCTION qwbe.echo_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.changes ? 'boom' OR NEW.row_id LIKE 'fault-%' THEN
        RAISE EXCEPTION 'injected activity fault';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER echo_test_fault BEFORE INSERT ON qwbe.activity
      FOR EACH ROW EXECUTE FUNCTION qwbe.echo_test_fault()`)
})

after(async () => {
  // Roles outlive the database; drop ours so a shared cluster does not collect one per run.
  for (const role of [readerRole, notesRole]) {
    await getPool()
      .query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`)
      .catch(() => {})
  }
  await closeAll()
  await db.drop()
})

describe("echo over a fresh Postgres", () => {
  it("first activity call on a fresh database creates the reader role and answers []", async () => {
    assert.equal(await roleExists(readerRole), false, "fresh database: reader role must not pre-exist")
    assert.deepEqual(await run(echo.page({ limit: 10 })), [])
    assert.equal(await roleExists(readerRole), true)
  })

  it("a plain cube role can neither read the log nor the comments", async () => {
    const denied = (e: unknown) => (e as { code?: string }).code === "42501"
    await assert.rejects(() => withRole(notesCube, (c) => c.query(`SELECT 1 FROM qwbe.activity`)), denied)
    await assert.rejects(() => withRole(notesCube, (c) => c.query(`SELECT 1 FROM qwbe.comment`)), denied)
  })

  it("captures the declared type only; rowState reads the current row", async () => {
    const before = await counts()
    const row = (await run(as(ana, notes.insert("notes", "Note", "note", { title: "t1" })))) as { id: string }
    await run(as(ana, notes.update("notes", row.id, { title: "t2" })))
    await run(as(bob, notes.update("notes", row.id, { deleted: true })))
    // Auxiliary table and type: written, never captured.
    const aux = (await run(as(ana, notes.insert("tags", "Tag", "tag", { name: "x" })))) as { id: string }
    await run(as(ana, notes.update("tags", aux.id, { name: "y" })))
    assert.equal((await counts()).activity, before.activity + 3)

    const feed = await run(echo.page({ cube: notesCube, entityId: row.id, limit: 10 }))
    assert.deepEqual(
      feed.map((a) => [a.op, a.version, a.actorId, a.actorUsername, a.entityType]),
      [
        ["delete", 3, "u-bob", "bob", "Note"],
        ["update", 2, "u-ana", "ana", "Note"],
        ["create", 1, "u-ana", "ana", "Note"],
      ],
    )
    assert.deepEqual(feed[2]?.changes, { title: { to: "t1" } })
    assert.deepEqual(feed[1]?.changes, { title: { from: "t1", to: "t2" } })
    assert.deepEqual(feed[0]?.changes, {})
    assert.deepEqual(await run(echo.page({ cube: notesCube, entityId: aux.id, limit: 10 })), [])

    assert.deepEqual(await run(state(row.id)), { id: row.id, type: "Note", deleted: true })
    await run(as(ana, notes.update("notes", row.id, { deleted: false })))
    assert.deepEqual(await run(state(row.id)), { id: row.id, type: "Note", deleted: false })
    assert.equal(await run(state(aux.id)), undefined)
    assert.equal(await run(state("note-nope")), undefined)
  })

  it("records NULL actor when there is no authenticated identity", async () => {
    const row = (await run(notes.insert("notes", "Note", "note", { title: "anon" }))) as { id: string }
    const [ev] = await run(echo.page({ cube: notesCube, entityId: row.id, limit: 1 }))
    assert.equal(ev?.op, "create")
    assert.equal(ev?.actorId, null)
    assert.equal(ev?.actorUsername, null)
  })

  it("insert: a failed activity insert leaves no row, no outbox entry, no activity", async () => {
    const before = await counts()
    await assert.rejects(
      () => run(as(ana, notes.insert("notes", "Note", "note", { title: "x", boom: true }))),
      /injected activity fault/,
    )
    assert.deepEqual(await counts(), before)
  })

  it("update: a failed activity insert leaves the row body and version untouched", async () => {
    const row = (await run(as(ana, notes.insert("notes", "Note", "note", { title: "keep" })))) as { id: string }
    const before = await counts()
    const stored = async () =>
      (await getPool().query(`SELECT version, body FROM "${notesSchema}"."notes" WHERE id = $1`, [row.id])).rows[0] as {
        version: number
        body: unknown
      }
    const was = await stored()
    await assert.rejects(() => run(as(ana, notes.update("notes", row.id, { boom: true }))), /injected activity fault/)
    assert.deepEqual(await stored(), was)
    assert.deepEqual(await counts(), before)
  })

  it("comments.add: a failed activity insert leaves no comment row", async () => {
    const before = await counts()
    await assert.rejects(
      () => run(as(ana, echo.comments.add({ cube: notesCube, entityType: "Note", entityId: "fault-1" }, "x"))),
      /injected activity fault/,
    )
    assert.deepEqual(await counts(), before)
  })

  it("comments: add writes one comment and one activity row; edit/remove pin the actor", async () => {
    const before = await counts()
    const target = { cube: notesCube, entityType: "Note", entityId: "note-c" }
    const added = await run(as(ana, echo.comments.add(target, "hello")))
    assert.equal(added.op, "comment")
    assert.equal(added.version, null)
    assert.equal(added.comment?.body, "hello")
    const after = await counts()
    assert.equal(after.activity, before.activity + 1)
    assert.equal(after.comment, before.comment + 1)
    const id = added.commentId as string

    assert.equal(await run(as(bob, echo.comments.edit(id, "hack"))), undefined)
    assert.equal(await run(echo.comments.edit(id, "anon")), undefined)
    assert.equal((await run(as(ana, echo.comments.edit(id, "hello2"))))?.body, "hello2")
    assert.equal(await run(as(bob, echo.comments.remove(id, false))), undefined)
    const removed = await run(as(bob, echo.comments.remove(id, true)))
    assert.equal(removed?.body, "")
    assert.equal(removed?.deletedBy, "u-bob")
    assert.equal(await run(as(bob, echo.comments.remove(id, true))), undefined)
    assert.equal((await run(echo.comments.byId(id)))?.body, "")
    // The feed's joined comment carries the wiped body, never the old text.
    const [ev] = await run(echo.page({ cube: notesCube, entityId: "note-c", limit: 1 }))
    assert.equal(ev?.comment?.body, "")
    assert.equal(ev?.comment?.deletedBy, "u-bob")
  })
})
