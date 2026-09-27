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
import { Effect, Exit, Scope } from "effect"
import { afterAll, beforeAll, describe, it } from "vitest"

import { CurrentActor } from "../kernel/actor.ts"
import { activityToolsFor } from "./activity.ts"
import { ident, roleName, schemaName, withRole } from "./setup.ts"
import { rowStateFor, storeFor } from "./store.ts"
import { testStore, withSql } from "./test-db.ts"

if (process.env.QWBE_PG_PORT === undefined && process.env.QWBE_PG_ALLOW_DEFAULT !== "1") {
  throw new Error(
    "echo-activity-pg.test.ts: set QWBE_PG_PORT to an isolated Postgres (see .pi/echo-pg-verification-plan.md) " +
      "or QWBE_PG_ALLOW_DEFAULT=1 to accept the helper default (localhost:5433)",
  )
}

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

const count = async (table: string): Promise<number> =>
  (await withSql((sql) => sql.unsafe<{ c: number }>(`SELECT COUNT(*)::int AS c FROM ${table}`)))[0]?.c ?? -1
const counts = async () => ({
  activity: await count("qwbe.activity"),
  comment: await count("qwbe.comment"),
  outbox: await count("qwbe.outbox"),
  notes: await count(`"${notesSchema}"."notes"`),
})
const roleExists = async (role: string): Promise<boolean> =>
  (await withSql((sql) => sql`SELECT 1 FROM pg_roles WHERE rolname = ${role}`)).length === 1

// The database and the store live in this scope: closing it closes the pool and drops the
// database, even when the setup below failed half-way.
const scope = Effect.runSync(Scope.make())

beforeAll(async () => {
  await Effect.runPromise(Scope.extend(testStore("echo"), scope))
  // Schema and tables are created lazily by the first store operation (ensureCubeSchema
  // creates only the schema and role; ensureTable creates the table). The `counts()` helper
  // reads the notes table with raw SQL, so warm it through the real read path first. A fresh
  // database must answer 0. This touches the notes cube only: the echo reader role is still
  // created by test 1, as it asserts.
  assert.equal(await run(notes.count("notes")), 0, "fresh database: notes table must start empty")
  // Test fixture ONLY: forces the activity INSERT to fail on demand, so the negative
  // atomicity cases go through the real store and comment code paths.
  await withSql((sql) =>
    sql.unsafe(`
    CREATE FUNCTION qwbe.echo_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.changes ? 'boom' OR NEW.row_id LIKE 'fault-%' THEN
        RAISE EXCEPTION 'injected activity fault';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER echo_test_fault BEFORE INSERT ON qwbe.activity
      FOR EACH ROW EXECUTE FUNCTION qwbe.echo_test_fault()`),
  )
})

afterAll(async () => {
  // Roles outlive the database; drop ours so a shared cluster does not collect one per run.
  for (const role of [readerRole, notesRole]) {
    await withSql((sql) => sql.unsafe(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`)).catch(() => {})
  }
  await Effect.runPromise(Scope.close(scope, Exit.void))
})

describe("echo over a fresh Postgres", () => {
  it("first activity call on a fresh database creates the reader role and answers []", async () => {
    assert.equal(await roleExists(readerRole), false, "fresh database: reader role must not pre-exist")
    assert.deepEqual(await run(echo.page({ limit: 10 })), [])
    assert.equal(await roleExists(readerRole), true)
  })

  it("a plain cube role can neither read the log nor the comments", async () => {
    const code = (table: string) =>
      withSql((sql) =>
        withRole(notesCube, sql.unsafe(`SELECT 1 FROM ${table}`)).pipe(
          Effect.match({ onSuccess: () => "", onFailure: (e) => String((e.cause as { code?: string }).code) }),
        ),
      )
    assert.equal(await code("qwbe.activity"), "42501")
    assert.equal(await code("qwbe.comment"), "42501")
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
      (
        await withSql(
          (sql) =>
            sql<{ version: number; body: unknown }>`SELECT version, body FROM ${ident(sql, notesSchema, "notes")}
                                                    WHERE id = ${row.id}`,
        )
      )[0]
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
