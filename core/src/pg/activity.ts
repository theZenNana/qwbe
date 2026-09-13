// The typed internal read interface over `qwbe.activity`, handed ONLY to the one cube whose
// manifest declares `readsActivity` (at-most-one checked at mount, discovery.ts). Built like
// `customFieldToolsFor` (kernel/store.ts). The echo cube is its consumer: the read feed over
// `page`, plus the A2 comment seam below.
//
// Every function runs under the reader cube's own role (`withRole`), which holds SELECT on
// `qwbe.activity` and -- since the A2 comment grants -- SELECT/INSERT/UPDATE on `qwbe.comment`
// and nothing else beyond its own schema. The grant is applied lazily here because `mount` is
// synchronous and the roles are created lazily by `ensureCubeSchema`.

import { Effect, FiberRef } from "effect"
import { CurrentActor } from "../kernel/actor.ts"
import { MAX_LIMIT } from "../kernel/pagination.ts"
import type { ActivityRow, ActivityTools, CommentRow } from "../kernel/store-contract.ts"
import { activityInsert } from "./rows.ts"
import { ensureActivityReader, withRole } from "./setup.ts"

/**
 * The comment's own columns as a pure row decoder. When the joined row is absent (a comment
 * row physically missing for a non-null comment_id -- not a state this seam writes), the
 * caller passes `comment_id: null` instead.
 */
const commentFrom = (r: Record<string, unknown>, cube: string, entityType: string, rowId: string): CommentRow => ({
  id: String(r.c_id),
  cube,
  entityType,
  rowId,
  actorId: r.c_actor_id === null || r.c_actor_id === undefined ? null : String(r.c_actor_id),
  actorUsername: r.c_actor_username === null || r.c_actor_username === undefined ? null : String(r.c_actor_username),
  body: String(r.c_body ?? ""),
  createdAt: new Date(r.c_created_at as string).toISOString(),
  editedAt:
    r.c_edited_at === null || r.c_edited_at === undefined ? null : new Date(r.c_edited_at as string).toISOString(),
  deletedAt:
    r.c_deleted_at === null || r.c_deleted_at === undefined ? null : new Date(r.c_deleted_at as string).toISOString(),
  deletedBy: r.c_deleted_by === null || r.c_deleted_by === undefined ? null : String(r.c_deleted_by),
})

const decode = (r: Record<string, unknown>): ActivityRow => ({
  id: Number(r.id),
  at: new Date(r.at as string).toISOString(),
  cube: String(r.cube),
  entityType: String(r.entity_type),
  rowId: String(r.row_id),
  op: String(r.op),
  version: r.version === null ? null : Number(r.version),
  actorId: r.actor_id === null ? null : String(r.actor_id),
  actorUsername: r.actor_username === null ? null : String(r.actor_username),
  commentId: r.comment_id === null || r.comment_id === undefined ? null : String(r.comment_id),
  changes: (r.changes as ActivityRow["changes"]) ?? {},
  // The joined comment (page's LEFT JOIN). The stored body is what it is: live text while the
  // comment lives, "" after the in-place deletion wiped it (deletedAt set, body withheld).
  comment:
    r.comment_id === null || r.comment_id === undefined || r.c_id === null || r.c_id === undefined
      ? null
      : commentFrom(r, String(r.cube), String(r.entity_type), String(r.row_id)),
})

const decodeComment = (r: Record<string, unknown>): CommentRow => ({
  id: String(r.id),
  cube: String(r.cube),
  entityType: String(r.entity_type),
  rowId: String(r.row_id),
  actorId: r.actor_id === null ? null : String(r.actor_id),
  actorUsername: r.actor_username === null ? null : String(r.actor_username),
  body: String(r.body),
  createdAt: new Date(r.created_at as string).toISOString(),
  editedAt: r.edited_at === null ? null : new Date(r.edited_at as string).toISOString(),
  deletedAt: r.deleted_at === null ? null : new Date(r.deleted_at as string).toISOString(),
  deletedBy: r.deleted_by === null ? null : String(r.deleted_by),
})

/** The actor read INSIDE the Effect.gen, before `Effect.promise` territory (store.ts pattern). */
const actorOf = Effect.gen(function* () {
  return yield* FiberRef.get(CurrentActor)
})

/**
 * Pure SQL for the comment UPDATEs, exported for the no-DB test (cubes/echo/echo.test.ts).
 * `edit` has NO moderator form: the WHERE always pins the actor's OWN row, so no caller can
 * rewrite another person's words. For `remove` the moderator flag decides the WHERE clause
 * and nothing else. Both refuse an already-deleted comment (undefined, not an error), and
 * `remove` always wipes the body in place -- the text never survives anywhere.
 */
export const commentEditSql = (): string =>
  `UPDATE qwbe.comment SET body = $2, edited_at = now()
   WHERE id = $1 AND actor_id = $3 AND deleted_at IS NULL RETURNING *`

export const commentRemoveSql = (moderator: boolean): string =>
  moderator
    ? `UPDATE qwbe.comment SET body = '', deleted_at = now(), deleted_by = $2
       WHERE id = $1 AND deleted_at IS NULL RETURNING *`
    : `UPDATE qwbe.comment SET body = '', deleted_at = now(), deleted_by = $2
       WHERE id = $1 AND actor_id = $3 AND deleted_at IS NULL RETURNING *`

const commentInsert = (): string =>
  `INSERT INTO qwbe.comment (id, cube, entity_type, row_id, actor_id, actor_username, body)
   VALUES ($1, $2, $3, $4, $5, $6, $7)`

export const activityToolsFor = (readerCube: string): ActivityTools => ({
  page: (query) =>
    Effect.promise(async () => {
      await ensureActivityReader(readerCube)
      return withRole(readerCube, async (c) => {
        const params: Array<unknown> = []
        const where: Array<string> = []
        if (query.cube !== undefined) {
          params.push(query.cube)
          where.push(`a.cube = $${params.length}`)
        }
        if (query.entityType !== undefined) {
          params.push(query.entityType)
          where.push(`a.entity_type = $${params.length}`)
        }
        if (query.entityId !== undefined) {
          params.push(query.entityId)
          where.push(`a.row_id = $${params.length}`)
        }
        if (query.beforeId !== undefined) {
          params.push(query.beforeId)
          where.push(`a.id < $${params.length}`)
        }
        params.push(Math.min(Math.max(1, query.limit), MAX_LIMIT))
        const r = await c.query(
          `SELECT a.id, a.at, a.cube, a.entity_type, a.row_id, a.op, a.version,
                  a.actor_id, a.actor_username, a.changes, a.comment_id,
                  c.id AS c_id, c.actor_id AS c_actor_id, c.actor_username AS c_actor_username,
                  c.body AS c_body, c.created_at AS c_created_at, c.edited_at AS c_edited_at,
                  c.deleted_at AS c_deleted_at, c.deleted_by AS c_deleted_by
           FROM qwbe.activity a
           LEFT JOIN qwbe.comment c ON c.id = a.comment_id
           WHERE ${where.join(" AND ") || "TRUE"} ORDER BY a.id DESC LIMIT $${params.length}`,
          params,
        )
        return r.rows.map((row) => decode(row as Record<string, unknown>))
      })
    }),

  comments: {
    // The comment row and its linked activity row go out in ONE withRole transaction (BEGIN /
    // SET LOCAL ROLE / ... / COMMIT, setup.ts): a rolled-back write rolls both back with it, so
    // "commented" and "recorded" cannot disagree -- the same rule as the store's capture. The
    // op is FORCED to "comment", changes to "{}" and version to NULL: this seam cannot forge a
    // mutation event, and the actor comes from the CurrentActor FiberRef, never a parameter.
    add: (target, body) =>
      Effect.gen(function* () {
        const actor = yield* actorOf
        return yield* Effect.promise(async () => {
          await ensureActivityReader(readerCube)
          return withRole(readerCube, async (c) => {
            const id = crypto.randomUUID()
            await c.query(commentInsert(), [
              id,
              target.cube,
              target.entityType,
              target.entityId,
              actor?.id ?? null,
              actor?.username ?? null,
              body,
            ])
            const event = activityInsert(
              target.cube,
              target.entityType,
              target.entityId,
              "comment",
              null,
              actor,
              {},
              id,
            )
            const r = await c.query(`${event.text} RETURNING id, at`, event.values)
            const row = r.rows[0] as { id: number; at: string }
            const at = new Date(row.at).toISOString()
            // The returned row carries the comment exactly as stored: both rows default their
            // timestamp to now(), which is the transaction timestamp, so createdAt === at.
            return {
              id: Number(row.id),
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
          })
        })
      }),

    byId: (id) =>
      Effect.promise(async () => {
        await ensureActivityReader(readerCube)
        return withRole(readerCube, async (c) => {
          const r = await c.query(`SELECT * FROM qwbe.comment WHERE id = $1`, [id])
          return r.rows[0] ? decodeComment(r.rows[0] as Record<string, unknown>) : undefined
        })
      }),

    edit: (id, body) =>
      Effect.gen(function* () {
        const actor = yield* actorOf
        return yield* Effect.promise(async () => {
          await ensureActivityReader(readerCube)
          return withRole(readerCube, async (c) => {
            // The row is pinned to the CURRENT actor's own comment; an actorless context
            // binds NULL, which matches nothing -- the edit then returns undefined and the
            // handler turns that into a 403. An already-deleted comment is refused in SQL.
            const r = await c.query(commentEditSql(), [id, body, actor?.id ?? null])
            return r.rows[0] ? decodeComment(r.rows[0] as Record<string, unknown>) : undefined
          })
        })
      }),

    remove: (id, moderator) =>
      Effect.gen(function* () {
        const actor = yield* actorOf
        return yield* Effect.promise(async () => {
          await ensureActivityReader(readerCube)
          return withRole(readerCube, async (c) => {
            const sql = commentRemoveSql(moderator)
            // deleted_by is the remover's id (NULL when contextless, same as A1); the
            // non-moderator WHERE also pins actor_id to the current actor, so a revoked or
            // anonymous caller cannot remove someone else's row even if it got this far.
            const params: Array<unknown> = moderator
              ? [id, actor?.id ?? null]
              : [id, actor?.id ?? null, actor?.id ?? null]
            const r = await c.query(sql, params)
            return r.rows[0] ? decodeComment(r.rows[0] as Record<string, unknown>) : undefined
          })
        })
      }),
  },
})
