// Echo (activity log + comments) against a REAL Postgres. Same harness as store.test.ts:
// one throwaway database per run, handed to the store as a layer, `@effect/vitest`.
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
import { layer } from "@effect/vitest"
import { Cause, Effect, Layer, Predicate } from "effect"

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

const as = <T>(actor: Actor, effect: Effect.Effect<T, never, never>): Effect.Effect<T, never, never> =>
  Effect.locally(effect, CurrentActor, actor)

/**
 * The printed cause of an effect that must fail, with each error's own `cause` (the driver's
 * message sits under SqlError's); the test fails if the effect succeeds instead.
 */
const failureOf = <A>(effect: Effect.Effect<A>) =>
  Effect.map(Effect.flip(Effect.sandbox(effect)), (cause) => Cause.pretty(cause, { renderErrorCause: true }))

// "notes" is the declared entity table (captureEntity "Note"); "tags" is auxiliary.
const notes = storeFor(notesCube, ["notes", "tags"], [], false, "Note")
const echo = activityToolsFor(echoCube)
const state = rowStateFor(notesCube, ["notes", "tags"], "Note")

const count = (table: string) =>
  Effect.map(
    withSql((sql) => sql.unsafe<{ c: number }>(`SELECT COUNT(*)::int AS c FROM ${table}`)),
    ([r]) => r?.c ?? -1,
  )
const counts = Effect.all({
  activity: count("qwbe.activity"),
  comment: count("qwbe.comment"),
  outbox: count("qwbe.outbox"),
  notes: count(`"${notesSchema}"."notes"`),
})
const roleExists = (role: string) =>
  Effect.map(
    withSql((sql) => sql`SELECT 1 FROM pg_roles WHERE rolname = ${role}`),
    (rows) => rows.length === 1,
  )

// The database and the store live in this layer's scope: closing it drops the roles, then closes
// the pool and drops the database, even when the setup below failed half-way.
const fixture = Layer.scopedDiscard(
  Effect.gen(function* () {
    // Roles outlive the database; drop ours so a shared cluster does not collect one per run.
    // Registered first, so it runs even when the setup below fails.
    yield* Effect.addFinalizer(() =>
      Effect.forEach([readerRole, notesRole], (role) =>
        Effect.exit(withSql((sql) => sql.unsafe(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`))),
      ),
    )
    // Schema and tables are created lazily by the first store operation (ensureCubeSchema
    // creates only the schema and role; ensureTable creates the table). The `counts` helper
    // reads the notes table with raw SQL, so warm it through the real read path first. A fresh
    // database must answer 0. This touches the notes cube only: the echo reader role is still
    // created by test 1, as it asserts.
    assert.equal(yield* notes.count("notes"), 0, "fresh database: notes table must start empty")
    // Test fixture ONLY: forces the activity INSERT to fail on demand, so the negative
    // atomicity cases go through the real store and comment code paths.
    yield* withSql((sql) =>
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
  }),
).pipe(Layer.provide(testStore("echo")))

layer(fixture, { timeout: 60_000, excludeTestServices: true })("echo over a fresh Postgres", (it) => {
  it.effect("first activity call on a fresh database creates the reader role and answers []", () =>
    Effect.gen(function* () {
      assert.equal(yield* roleExists(readerRole), false, "fresh database: reader role must not pre-exist")
      assert.deepEqual(yield* echo.page({ limit: 10 }), [])
      assert.equal(yield* roleExists(readerRole), true)
    }),
  )

  it.effect("a plain cube role can neither read the log nor the comments", () =>
    Effect.gen(function* () {
      const code = (table: string) =>
        withSql((sql) =>
          withRole(notesCube, sql.unsafe(`SELECT 1 FROM ${table}`)).pipe(
            Effect.match({
              onSuccess: () => "",
              onFailure: (e) => String(Predicate.hasProperty(e.cause, "code") ? e.cause.code : undefined),
            }),
          ),
        )
      assert.equal(yield* code("qwbe.activity"), "42501")
      assert.equal(yield* code("qwbe.comment"), "42501")
    }),
  )

  it.effect("captures the declared type only; rowState reads the current row", () =>
    Effect.gen(function* () {
      const before = yield* counts
      const row = (yield* as(ana, notes.insert("notes", "Note", "note", { title: "t1" }))) as { id: string }
      yield* as(ana, notes.update("notes", row.id, { title: "t2" }))
      yield* as(bob, notes.update("notes", row.id, { deleted: true }))
      // Auxiliary table and type: written, never captured.
      const aux = (yield* as(ana, notes.insert("tags", "Tag", "tag", { name: "x" }))) as { id: string }
      yield* as(ana, notes.update("tags", aux.id, { name: "y" }))
      assert.equal((yield* counts).activity, before.activity + 3)

      const feed = yield* echo.page({ cube: notesCube, entityId: row.id, limit: 10 })
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
      assert.deepEqual(yield* echo.page({ cube: notesCube, entityId: aux.id, limit: 10 }), [])

      assert.deepEqual(yield* state(row.id), { id: row.id, type: "Note", deleted: true })
      yield* as(ana, notes.update("notes", row.id, { deleted: false }))
      assert.deepEqual(yield* state(row.id), { id: row.id, type: "Note", deleted: false })
      assert.equal(yield* state(aux.id), undefined)
      assert.equal(yield* state("note-nope"), undefined)
    }),
  )

  it.effect("records NULL actor when there is no authenticated identity", () =>
    Effect.gen(function* () {
      const row = (yield* notes.insert("notes", "Note", "note", { title: "anon" })) as { id: string }
      const [ev] = yield* echo.page({ cube: notesCube, entityId: row.id, limit: 1 })
      assert.equal(ev?.op, "create")
      assert.equal(ev?.actorId, null)
      assert.equal(ev?.actorUsername, null)
    }),
  )

  it.effect("insert: a failed activity insert leaves no row, no outbox entry, no activity", () =>
    Effect.gen(function* () {
      const before = yield* counts
      assert.match(
        yield* failureOf(as(ana, notes.insert("notes", "Note", "note", { title: "x", boom: true }))),
        /injected activity fault/,
      )
      assert.deepEqual(yield* counts, before)
    }),
  )

  it.effect("update: a failed activity insert leaves the row body and version untouched", () =>
    Effect.gen(function* () {
      const row = (yield* as(ana, notes.insert("notes", "Note", "note", { title: "keep" }))) as { id: string }
      const before = yield* counts
      const stored = Effect.map(
        withSql(
          (sql) =>
            sql<{ version: number; body: unknown }>`SELECT version, body FROM ${ident(sql, notesSchema, "notes")}
                                                    WHERE id = ${row.id}`,
        ),
        (rows) => rows[0],
      )
      const was = yield* stored
      assert.match(yield* failureOf(as(ana, notes.update("notes", row.id, { boom: true }))), /injected activity fault/)
      assert.deepEqual(yield* stored, was)
      assert.deepEqual(yield* counts, before)
    }),
  )

  it.effect("comments.add: a failed activity insert leaves no comment row", () =>
    Effect.gen(function* () {
      const before = yield* counts
      assert.match(
        yield* failureOf(as(ana, echo.comments.add({ cube: notesCube, entityType: "Note", entityId: "fault-1" }, "x"))),
        /injected activity fault/,
      )
      assert.deepEqual(yield* counts, before)
    }),
  )

  it.effect("comments: add writes one comment and one activity row; edit/remove pin the actor", () =>
    Effect.gen(function* () {
      const before = yield* counts
      const target = { cube: notesCube, entityType: "Note", entityId: "note-c" }
      const added = yield* as(ana, echo.comments.add(target, "hello"))
      assert.equal(added.op, "comment")
      assert.equal(added.version, null)
      assert.equal(added.comment?.body, "hello")
      const after = yield* counts
      assert.equal(after.activity, before.activity + 1)
      assert.equal(after.comment, before.comment + 1)
      const id = added.commentId as string

      assert.equal(yield* as(bob, echo.comments.edit(id, "hack")), undefined)
      assert.equal(yield* echo.comments.edit(id, "anon"), undefined)
      assert.equal((yield* as(ana, echo.comments.edit(id, "hello2")))?.body, "hello2")
      assert.equal(yield* as(bob, echo.comments.remove(id, false)), undefined)
      const removed = yield* as(bob, echo.comments.remove(id, true))
      assert.equal(removed?.body, "")
      assert.equal(removed?.deletedBy, "u-bob")
      assert.equal(yield* as(bob, echo.comments.remove(id, true)), undefined)
      assert.equal((yield* echo.comments.byId(id))?.body, "")
      // The feed's joined comment carries the wiped body, never the old text.
      const [ev] = yield* echo.page({ cube: notesCube, entityId: "note-c", limit: 1 })
      assert.equal(ev?.comment?.body, "")
      assert.equal(ev?.comment?.deletedBy, "u-bob")
    }),
  )
})
