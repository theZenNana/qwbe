// The typed internal read interface over `qwbe.activity`, handed ONLY to the one cube whose
// manifest declares `readsActivity` (at-most-one checked at mount, discovery.ts). Built like
// `customFieldToolsFor` (kernel/store.ts). The echo cube is its consumer: the read feed over
// `page`, plus the A2 comment seam below.
//
// Every function runs under the reader cube's own role (`withRole`), which holds SELECT on
// `qwbe.activity` and -- since the A2 comment grants -- SELECT/INSERT/UPDATE on `qwbe.comment`
// and nothing else beyond its own schema. The grant is applied lazily here because `mount` is
// synchronous and the roles are created lazily by `ensureCubeSchema`.

import { SqlClient, type Statement } from "@effect/sql"
import { DateTime, Effect, FiberRef, Schema } from "effect"
import { CurrentActor } from "../kernel/actor.ts"
import { MAX_LIMIT } from "../kernel/pagination.ts"
import type { ActivityRow, ActivityTools, CommentRow } from "../kernel/store-contract.ts"
import { run } from "./db.ts"
import { activityInsert, compileOnly } from "./rows.ts"
import { ensureActivityReader, withRole } from "./setup.ts"

/** A timestamptz column (pg hands it over as a Date) as the ISO string the contract carries. */
const Iso = Schema.transform(Schema.DateFromSelf, Schema.String, {
  strict: true,
  decode: (d) => DateTime.formatIso(DateTime.unsafeFromDate(d)),
  encode: (s) => DateTime.toDateUtc(DateTime.unsafeMake(s)),
})

const Changes = Schema.Record({
  key: Schema.String,
  value: Schema.Struct({ from: Schema.optional(Schema.Unknown), to: Schema.optional(Schema.Unknown) }),
})

/** A `qwbe.comment` row, as `SELECT *` and `RETURNING *` produce it. */
const CommentFromRow = Schema.Struct({
  id: Schema.String,
  cube: Schema.String,
  entity_type: Schema.String,
  row_id: Schema.String,
  actor_id: Schema.NullOr(Schema.String),
  actor_username: Schema.NullOr(Schema.String),
  body: Schema.String,
  created_at: Iso,
  edited_at: Schema.NullOr(Iso),
  deleted_at: Schema.NullOr(Iso),
  deleted_by: Schema.NullOr(Schema.String),
}).pipe(
  Schema.rename({
    entity_type: "entityType",
    row_id: "rowId",
    actor_id: "actorId",
    actor_username: "actorUsername",
    created_at: "createdAt",
    edited_at: "editedAt",
    deleted_at: "deletedAt",
    deleted_by: "deletedBy",
  }),
)

/** One row of `page`'s query: the activity columns plus the LEFT JOINed comment (`c_*`). */
const FeedRow = Schema.Struct({
  // bigserial: pg hands int8 over as a string.
  id: Schema.NumberFromString,
  at: Iso,
  cube: Schema.String,
  entity_type: Schema.String,
  row_id: Schema.String,
  op: Schema.String,
  version: Schema.NullOr(Schema.Number),
  actor_id: Schema.NullOr(Schema.String),
  actor_username: Schema.NullOr(Schema.String),
  comment_id: Schema.NullOr(Schema.String),
  changes: Schema.NullOr(Changes),
  c_id: Schema.NullOr(Schema.String),
  c_actor_id: Schema.NullOr(Schema.String),
  c_actor_username: Schema.NullOr(Schema.String),
  c_body: Schema.NullOr(Schema.String),
  c_created_at: Schema.NullOr(Iso),
  c_edited_at: Schema.NullOr(Iso),
  c_deleted_at: Schema.NullOr(Iso),
  c_deleted_by: Schema.NullOr(Schema.String),
})

const feedRow = (r: typeof FeedRow.Type): ActivityRow => ({
  id: r.id,
  at: r.at,
  cube: r.cube,
  entityType: r.entity_type,
  rowId: r.row_id,
  op: r.op,
  version: r.version,
  actorId: r.actor_id,
  actorUsername: r.actor_username,
  commentId: r.comment_id,
  changes: r.changes ?? {},
  // The joined comment. The stored body is what it is: live text while the comment lives, ""
  // after the in-place deletion wiped it (deletedAt set, body withheld). A comment row
  // physically missing for a non-null comment_id is not a state this seam writes: null.
  comment:
    r.comment_id === null || r.c_id === null
      ? null
      : {
          id: r.c_id,
          cube: r.cube,
          entityType: r.entity_type,
          rowId: r.row_id,
          actorId: r.c_actor_id,
          actorUsername: r.c_actor_username,
          body: r.c_body ?? "",
          createdAt: r.c_created_at ?? r.at,
          editedAt: r.c_edited_at,
          deletedAt: r.c_deleted_at,
          deletedBy: r.c_deleted_by,
        },
})

const firstComment = (rows: ReadonlyArray<unknown>) =>
  Effect.map(Schema.decodeUnknown(Schema.Array(CommentFromRow))(rows), (decoded): CommentRow | undefined => decoded[0])

/**
 * The comment UPDATEs. `edit` has NO moderator form: the WHERE always pins the actor's OWN row,
 * so no caller can rewrite another person's words. For `remove` the moderator flag decides the
 * WHERE clause and nothing else. Both refuse an already-deleted comment (undefined, not an
 * error), and `remove` always wipes the body in place -- the text never survives anywhere.
 */
const commentEdit = (sql: Statement.Constructor, id: string, body: string, actorId: string | null) =>
  sql`UPDATE qwbe.comment SET body = ${body}, edited_at = now()
      WHERE id = ${id} AND actor_id = ${actorId} AND deleted_at IS NULL RETURNING *`

const commentRemove = (sql: Statement.Constructor, id: string, moderator: boolean, actorId: string | null) =>
  moderator
    ? sql`UPDATE qwbe.comment SET body = '', deleted_at = now(), deleted_by = ${actorId}
          WHERE id = ${id} AND deleted_at IS NULL RETURNING *`
    : sql`UPDATE qwbe.comment SET body = '', deleted_at = now(), deleted_by = ${actorId}
          WHERE id = ${id} AND actor_id = ${actorId} AND deleted_at IS NULL RETURNING *`

// The same statements compiled without a database, for the no-DB test (cubes/echo/echo.test.ts).
export const commentEditSql = (): string => commentEdit(compileOnly, "", "", null).compile()[0]
export const commentRemoveSql = (moderator: boolean): string =>
  commentRemove(compileOnly, "", moderator, null).compile()[0]

/** One reader operation: the reader grant first, then one transaction under the reader's role. */
const asReader = <A>(
  readerCube: string,
  f: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown, SqlClient.SqlClient>,
) =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* ensureActivityReader(readerCube)
      return yield* withRole(readerCube, f(sql))
    }),
  )

export const activityToolsFor = (readerCube: string): ActivityTools => ({
  page: (query) =>
    asReader(readerCube, (sql) => {
      const where = [
        query.cube === undefined ? undefined : sql`a.cube = ${query.cube}`,
        query.entityType === undefined ? undefined : sql`a.entity_type = ${query.entityType}`,
        query.entityId === undefined ? undefined : sql`a.row_id = ${query.entityId}`,
        query.beforeId === undefined ? undefined : sql`a.id < ${query.beforeId}`,
      ].filter((c) => c !== undefined)
      return sql`SELECT a.id, a.at, a.cube, a.entity_type, a.row_id, a.op, a.version,
                        a.actor_id, a.actor_username, a.changes, a.comment_id,
                        c.id AS c_id, c.actor_id AS c_actor_id, c.actor_username AS c_actor_username,
                        c.body AS c_body, c.created_at AS c_created_at, c.edited_at AS c_edited_at,
                        c.deleted_at AS c_deleted_at, c.deleted_by AS c_deleted_by
                 FROM qwbe.activity a
                 LEFT JOIN qwbe.comment c ON c.id = a.comment_id
                 WHERE ${sql.and(where)} ORDER BY a.id DESC LIMIT ${Math.min(Math.max(1, query.limit), MAX_LIMIT)}`.pipe(
        Effect.flatMap(Schema.decodeUnknown(Schema.Array(FeedRow))),
        Effect.map((rows) => rows.map(feedRow)),
      )
    }),

  comments: {
    // The comment row and its linked activity row go out in ONE withRole transaction (setup.ts):
    // a rolled-back write rolls both back with it, so "commented" and "recorded" cannot
    // disagree -- the same rule as the store's capture. The op is FORCED to "comment", changes
    // to "{}" and version to NULL: this seam cannot forge a mutation event, and the actor comes
    // from the CurrentActor FiberRef, never a parameter.
    add: (target, body) =>
      asReader(readerCube, (sql) =>
        Effect.gen(function* () {
          const actor = yield* FiberRef.get(CurrentActor)
          // Effect has no UUID of its own; the global one runs as a side effect in here.
          const id = yield* Effect.sync(() => crypto.randomUUID())
          yield* sql`INSERT INTO qwbe.comment (id, cube, entity_type, row_id, actor_id, actor_username, body)
                     VALUES (${id}, ${target.cube}, ${target.entityType}, ${target.entityId},
                             ${actor?.id ?? null}, ${actor?.username ?? null}, ${body})`
          const event = activityInsert(
            sql,
            target.cube,
            target.entityType,
            target.entityId,
            "comment",
            null,
            actor,
            {},
            id,
          )
          const [row] = yield* Effect.flatMap(
            sql`${event} RETURNING id, at`,
            Schema.decodeUnknown(Schema.Array(Schema.Struct({ id: Schema.NumberFromString, at: Iso }))),
          )
          const at = row?.at ?? ""
          // The returned row carries the comment exactly as stored: both rows default their
          // timestamp to now(), which is the transaction timestamp, so createdAt === at.
          return {
            id: row?.id ?? 0,
            at,
            cube: target.cube,
            entityType: target.entityType,
            rowId: target.entityId,
            op: "comment",
            version: null,
            actorId: actor?.id ?? null,
            actorUsername: actor?.username ?? null,
            commentId: id,
            changes: {},
            comment: {
              id,
              cube: target.cube,
              entityType: target.entityType,
              rowId: target.entityId,
              actorId: actor?.id ?? null,
              actorUsername: actor?.username ?? null,
              body,
              createdAt: at,
              editedAt: null,
              deletedAt: null,
              deletedBy: null,
            },
          } satisfies ActivityRow
        }),
      ),

    byId: (id) =>
      asReader(readerCube, (sql) => Effect.flatMap(sql`SELECT * FROM qwbe.comment WHERE id = ${id}`, firstComment)),

    // The row is pinned to the CURRENT actor's own comment; an actorless context binds NULL,
    // which matches nothing -- the edit then returns undefined and the handler turns that into
    // a 403. An already-deleted comment is refused in SQL.
    edit: (id, body) =>
      asReader(readerCube, (sql) =>
        Effect.flatMap(FiberRef.get(CurrentActor), (actor) =>
          Effect.flatMap(commentEdit(sql, id, body, actor?.id ?? null), firstComment),
        ),
      ),

    // deleted_by is the remover's id (NULL when contextless, same as A1); the non-moderator
    // WHERE also pins actor_id to the current actor, so a revoked or anonymous caller cannot
    // remove someone else's row even if it got this far.
    remove: (id, moderator) =>
      asReader(readerCube, (sql) =>
        Effect.flatMap(FiberRef.get(CurrentActor), (actor) =>
          Effect.flatMap(commentRemove(sql, id, moderator, actor?.id ?? null), firstComment),
        ),
      ),
  },
})
