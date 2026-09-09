// The ECHO cube -- feed and comments over the kernel activity log (Echo A2).
//
// It holds the single `readsActivity` capability and serves FOUR routes:
//
//     GET    /echo/feed?cube=&entityId=&before=&limit=
//     POST   /echo/comments?cube=&entityId=          { body }
//     PATCH  /echo/comments/:id                      { body }
//     DELETE /echo/comments/:id
//
//   - `feed` with `entityId`: the per-target feed. The target is gated ONCE, up front, and
//     the whole history of that row is returned; a failed gate is a 403, never a silent empty
//     page (missing target and denied both fail closed).
//   - `feed` without `entityId`: the general feed, filtered by `cube` when given. Rows are
//     scanned newest-first and filtered per row through `feedRowVisible` (see feed.ts); the
//     cursor advances by the LAST SCANNED row, so pages of hidden rows still move forward.
//   - The comment routes write through the activity tool's comment seam: the comment row and
//     its linked activity row go out in ONE transaction (pg/activity.ts), with `op` forced to
//     "comment" and the body stored ONLY in qwbe.comment -- the log never carries text.
//
// Cube and entity travel as QUERY parameters on purpose: cube identities may contain a slash
// (`<parent>/<child>`), so a path-shaped target would be ambiguous. The comment's own id is
// kernel-generated (no slash), so the edit/delete routes may carry it in the path.
//
// There is deliberately NO admin bypass in this file. Admin authority comes from grants: the
// permission foundation answers the entity read for admin on live cubes, and admin holds the
// declared permissions -- on cubes that are not mounted, nothing grants it and nothing shows.
// A row whose target does not currently resolve (missing, disabled cube, entity type no longer
// captured) is hidden from everyone, and NO comment write lands on a target that does not pass
// the live gate -- deleted targets included.
//
// Deleted-record history (Echo A3): the feed alone may show the history of a row that the
// owning store CURRENTLY reports as `deleted = true` (`Registry.targetState`, a kernel-built
// `{ id, type, deleted }` lookup under the owning role -- never the activity log, whose latest
// event is not truth: a batch write bypasses capture). Even then only to a caller whose
// existing entity decision on that target has source "superadmin" or "cube-admin", behind the
// same capture and read-route gates as a live row. A live target is always the ordinary
// entity read; a missing, disabled or mismatched one stays hidden from everyone, admin
// included. No new permission, no bypass anywhere else.
//
// Moderation, per the permission decision source: whoever's entity decision on the TARGET
// comes back with source "superadmin" or "cube-admin" may DELETE any comment on it. Nobody --
// not even a superadmin -- edits another person's words. The author edits and deletes their
// own comment only while the target still passes the gate for them (read route held, summary
// live, entity edit allowed): revoking target access revokes comment authority with it.

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Schema } from "effect"
import { defineCube } from "qwbe-core/cube"
import { Authorization, CurrentUser, requirePermission } from "../../kernel/auth-contract.ts"
import { Forbidden } from "../../kernel/errors.ts"
import type { ActivityRow, CommentRow } from "../../kernel/manifest.ts"
import { Registry } from "../../kernel/registry.ts"
import { commentAuthority, type FeedTargetMeta, feedRowVisible, readRouteCap, visiblePage } from "./feed.ts"

/** The comment as the comment routes and the feed carry it. `body` is "" once deleted. */
const FeedComment = Schema.Struct({
  id: Schema.String,
  cube: Schema.String,
  entityType: Schema.String,
  rowId: Schema.String,
  actorId: Schema.NullOr(Schema.String),
  actorUsername: Schema.NullOr(Schema.String),
  body: Schema.String,
  createdAt: Schema.String,
  editedAt: Schema.NullOr(Schema.String),
  deletedAt: Schema.NullOr(Schema.String),
  deletedBy: Schema.NullOr(Schema.String),
}).annotations({ identifier: "FeedComment" })

const FeedRow = Schema.Struct({
  id: Schema.Number,
  at: Schema.String,
  cube: Schema.String,
  entityType: Schema.String,
  rowId: Schema.String,
  op: Schema.String,
  version: Schema.NullOr(Schema.Number),
  actorId: Schema.NullOr(Schema.String),
  actorUsername: Schema.NullOr(Schema.String),
  changes: Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  commentId: Schema.NullOr(Schema.String),
  /** Filled from qwbe.comment when the row IS a comment; null otherwise. */
  comment: Schema.NullOr(FeedComment),
}).annotations({ identifier: "FeedRow" })

const FeedResponse = Schema.Struct({
  rows: Schema.Array(FeedRow),
  /** Id of the last SCANNED row; null when the scan is exhausted. */
  nextBefore: Schema.NullOr(Schema.Number),
}).annotations({ identifier: "FeedResponse" })

const FeedQuery = Schema.Struct({
  cube: Schema.optional(Schema.String),
  entityId: Schema.optional(Schema.String),
  // Trust boundary (same class as kernel/pagination.ts): NumberFromString decodes "NaN",
  // "Infinity" and "1e400"; `int()` is Number.isSafeInteger, so those and fractions are a 400
  // here instead of a pg bigint / LIMIT error. The MAX_LIMIT clamp in pg/activity.ts stays.
  before: Schema.optional(Schema.NumberFromString.pipe(Schema.int(), Schema.positive())),
  limit: Schema.optional(Schema.NumberFromString.pipe(Schema.int(), Schema.positive())),
})

/** Trimmed (a transformation, not a filter: " hi " stores "hi"), nonempty after trimming,
 * capped: the ONE body boundary every comment write crosses. */
const CommentBody = Schema.Struct({
  body: Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(4000)),
}).annotations({ identifier: "CommentBody" })

/** The comment TARGET as query parameters -- slash-safe, same choice as the feed route. */
const CommentTarget = Schema.Struct({
  cube: Schema.String,
  entityId: Schema.String,
})

const group = HttpApiGroup.make("echo")
  .add(HttpApiEndpoint.get("feed")`/echo/feed`.setUrlParams(FeedQuery).addSuccess(FeedResponse).addError(Forbidden))
  .add(
    HttpApiEndpoint.post("addComment")`/echo/comments`
      .setUrlParams(CommentTarget)
      .setPayload(CommentBody)
      .addSuccess(FeedRow)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.patch("editComment")`/echo/comments/${HttpApiSchema.param("id", Schema.String)}`
      .setPayload(CommentBody)
      .addSuccess(FeedComment)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.del("deleteComment")`/echo/comments/${HttpApiSchema.param("id", Schema.String)}`
      .addSuccess(FeedComment)
      .addError(Forbidden),
  )
  .middleware(Authorization)

const ROUTES = {
  feed: "echo:read",
  addComment: "echo:write",
  editComment: "echo:write",
  deleteComment: "echo:write",
} as const

const DEFAULT_FEED_LIMIT = 50

/** The cache key for one target. A separator the caller cannot produce keeps it unambiguous. */
const targetKey = (cube: string, rowId: string) => `${cube}\u0000${rowId}`

export const cube = defineCube(group, {
  manifest: {
    name: "echo",
    tables: [],
    requiresAuth: true,
    readsActivity: true,
    // The comment routes ask the REAL entity permission service about the TARGET (the edit
    // decision for writes, the decision source for moderation). No new permission beyond
    // echo:write; no alternate ACL anywhere.
    usesEntityPermissions: true,
    permissions: [
      { name: "echo:read", roles: ["admin", "reader"] },
      { name: "echo:write", roles: ["admin", "reader"] },
    ],
    routes: ROUTES,
  },

  create: ({ activity, catalogue, entityPermissions }) => {
    if (!activity) throw new Error("echo requires the readsActivity capability")
    if (!activity.comments) throw new Error("echo requires the comment seam on the activity tool")
    if (!entityPermissions) throw new Error("echo requires the entity permissions capability")
    const page = activity.page
    const comments = activity.comments
    const authorize = entityPermissions.authorize

    /**
     * The ONE target gate, shared by the feed and every comment write: the cube must
     * currently capture the entity, the caller must hold its canonical read route, and
     * `Registry.summary` must resolve the row RIGHT NOW (missing, deleted, disabled cube,
     * entity-revoked all fail closed). Admin gets NO bypass: its authority comes from
     * grants on live cubes, exactly like the feed. Returns the capture entity on success.
     *
     * `history` (the FEED only, never a comment write) lets a summary miss fall through to
     * `deletedHistoryVisible`: a currently-deleted target, for its moderators.
     */
    const gatedTarget = (
      registry: typeof Registry.Service,
      user: CurrentUser["Type"],
      cube: string,
      entityId: string,
      history = false,
    ) =>
      Effect.gen(function* () {
        const capture = registry.captureOf(cube)
        if (capture === undefined) {
          return yield* Effect.fail(
            new Forbidden({ message: `${cube} does not capture activity`, needed: ROUTES.feed }),
          )
        }
        if (readRouteCap(catalogue().find((c) => c.name === cube)?.metadata?.routes, user.permissions) === null) {
          return yield* Effect.fail(new Forbidden({ message: "no readable route on that cube", needed: ROUTES.feed }))
        }
        const summary = yield* registry.summary(capture, entityId, user)
        if (
          summary === undefined &&
          !(history && (yield* deletedHistoryVisible(registry, user, cube, capture, entityId)))
        ) {
          return yield* Effect.fail(
            new Forbidden({ message: "this entity is not shared with you", needed: ROUTES.feed }),
          )
        }
        return capture
      })

    /** Moderation is a permission DECISION SOURCE, not a role list: superadmin or cube-admin. */
    const moderatorDecision = (d: { readonly allowed: boolean; readonly source: string }): boolean =>
      d.allowed && (d.source === "superadmin" || d.source === "cube-admin")

    /**
     * Echo A3, feed only: may this caller see the HISTORY of a target the summary did not
     * resolve? Yes only when the owning store currently reports the row as deleted (type
     * matching the capture entity -- `targetState` answers nothing otherwise) AND the
     * caller's entity read decision on it comes from superadmin or cube-admin. Missing,
     * disabled, mismatched: false, for everyone. The activity log is never consulted.
     */
    const deletedHistoryVisible = (
      registry: typeof Registry.Service,
      user: CurrentUser["Type"],
      cube: string,
      capture: string,
      entityId: string,
    ) =>
      Effect.gen(function* () {
        const state = yield* registry.targetState(cube, entityId)
        if (state === undefined || !state.deleted) return false
        const d = yield* authorize(
          { userId: user.id, roles: user.roles },
          { cube, entityType: capture, entityId },
          "read",
        ).pipe(Effect.orDie)
        return moderatorDecision(d)
      })

    /**
     * The comment being edited or deleted, or a 403. A deleted comment is gone: no edit, no
     * re-delete. The comment's CURRENT target must pass the gate for this caller, and the
     * cube's CURRENT capture entity must still be the one the comment was written against
     * (the feed hides such a row through `feedRowVisible`; the writes refuse it here, as
     * migration 0004 promises: a stale comment is never edited against a target that has
     * since changed identity).
     */
    const gatedComment = (registry: typeof Registry.Service, user: CurrentUser["Type"], id: string) =>
      Effect.gen(function* () {
        const c = yield* comments.byId(id)
        if (!c || c.deletedAt !== null) {
          return yield* Effect.fail(new Forbidden({ message: "no such comment", needed: ROUTES.editComment }))
        }
        const capture = yield* gatedTarget(registry, user, c.cube, c.rowId)
        if (capture !== c.entityType) {
          return yield* Effect.fail(
            new Forbidden({ message: "this entity is not shared with you", needed: ROUTES.editComment }),
          )
        }
        return c
      })

    /** The entity decision on a comment's CURRENT target. A permission-service failure is a
     * broken backend, not a refusal -- it dies like the entity routes' own read decision. */
    const decision = (user: CurrentUser["Type"], c: CommentRow, action: "edit" | "delete") =>
      authorize(
        { userId: user.id, roles: user.roles },
        { cube: c.cube, entityType: c.entityType, entityId: c.rowId },
        action,
      ).pipe(Effect.orDie)

    return {
      handlers: {
        feed: ({ urlParams }: { urlParams: typeof FeedQuery.Type }) =>
          Effect.gen(function* () {
            yield* requirePermission(ROUTES.feed)
            const registry = yield* Registry
            const user = yield* CurrentUser
            const limit = urlParams.limit ?? DEFAULT_FEED_LIMIT

            // --- per-target feed: one gate, then the whole history of that row ---
            if (urlParams.entityId !== undefined) {
              const cube = urlParams.cube
              if (cube === undefined) {
                return yield* Effect.fail(new Forbidden({ message: "entityId requires cube", needed: ROUTES.feed }))
              }
              // Registry existence BEFORE any access: the cube must currently capture this
              // entity, or the row is history from a cube that no longer does.
              const capture = yield* gatedTarget(registry, user, cube, urlParams.entityId, true)
              const rows = yield* page({
                cube,
                entityType: capture,
                entityId: urlParams.entityId,
                limit,
                ...(urlParams.before !== undefined ? { beforeId: urlParams.before } : {}),
              })
              return { rows, nextBefore: rows.length > 0 ? rows[rows.length - 1]!.id : null }
            }

            // --- general feed: scan, then filter per row against CURRENT state ---
            const scanned: ReadonlyArray<ActivityRow> = yield* page({
              limit,
              ...(urlParams.cube !== undefined ? { cube: urlParams.cube } : {}),
              ...(urlParams.before !== undefined ? { beforeId: urlParams.before } : {}),
            })

            // Per-cube metadata, resolved once: capture entity + the read-route cap the caller
            // holds in the cube's mounted route metadata.
            const metaByCube = new Map<string, FeedTargetMeta>()
            const metaFor = (cube: string): FeedTargetMeta => {
              const cached = metaByCube.get(cube)
              if (cached) return cached
              const meta: FeedTargetMeta = {
                capture: registry.captureOf(cube),
                readCap: readRouteCap(catalogue().find((c) => c.name === cube)?.metadata?.routes, user.permissions),
              }
              metaByCube.set(cube, meta)
              return meta
            }

            // Target visibility per distinct target, memoized for the request: the summary
            // resolves (live, readable), or the deleted-history rule holds. Asked only for
            // rows that already passed the capture and route-cap gates.
            const targetVisible = new Map<string, boolean>()
            for (const row of scanned) {
              const meta = metaFor(row.cube)
              const key = targetKey(row.cube, row.rowId)
              if (targetVisible.has(key)) continue
              if (meta.capture === undefined || meta.capture !== row.entityType || meta.readCap === null) continue
              const summary = yield* registry.summary(meta.capture, row.rowId, user)
              targetVisible.set(
                key,
                summary !== undefined ||
                  (yield* deletedHistoryVisible(registry, user, row.cube, meta.capture, row.rowId)),
              )
            }

            return visiblePage(scanned, (row) => {
              const meta = metaFor(row.cube)
              return feedRowVisible(meta, row, targetVisible.get(targetKey(row.cube, row.rowId)) ?? false)
            })
          }),

        // --- add a comment: read-route + summary + entity edit on the target, no bypass ---
        addComment: ({
          urlParams,
          payload,
        }: {
          urlParams: typeof CommentTarget.Type
          payload: typeof CommentBody.Type
        }) =>
          Effect.gen(function* () {
            yield* requirePermission(ROUTES.addComment)
            const registry = yield* Registry
            const user = yield* CurrentUser
            const capture = yield* gatedTarget(registry, user, urlParams.cube, urlParams.entityId)
            // The write needs the entity EDIT decision on the target, from the SAME service
            // the entity routes use -- not a role check, not a shadow rule.
            const d = yield* authorize(
              { userId: user.id, roles: user.roles },
              { cube: urlParams.cube, entityType: capture, entityId: urlParams.entityId },
              "edit",
            ).pipe(Effect.orDie)
            if (!d.allowed) {
              return yield* Effect.fail(
                new Forbidden({ message: "this entity is not shared with you", needed: ROUTES.addComment }),
              )
            }
            return yield* comments.add(
              { cube: urlParams.cube, entityType: capture, entityId: urlParams.entityId },
              payload.body,
            )
          }),

        // --- edit a comment: the AUTHOR only, against the CURRENT target gates. Nobody --
        // not a moderator, not a superadmin -- ever edits another person's words. ---
        editComment: ({ path, payload }: { path: { id: string }; payload: typeof CommentBody.Type }) =>
          Effect.gen(function* () {
            yield* requirePermission(ROUTES.editComment)
            const registry = yield* Registry
            const user = yield* CurrentUser
            const c = yield* gatedComment(registry, user, path.id)
            const d = yield* decision(user, c, "edit")
            const authority = commentAuthority(c, user.id, false, d.allowed)
            if (authority !== "owner") {
              return yield* Effect.fail(
                new Forbidden({ message: "only the author may edit a comment", needed: ROUTES.editComment }),
              )
            }
            const updated = yield* comments.edit(path.id, payload.body)
            if (!updated) {
              return yield* Effect.fail(new Forbidden({ message: "no such comment", needed: ROUTES.editComment }))
            }
            return updated
          }),

        // --- delete a comment: the author (same gates as edit) or a MODERATOR, where
        // moderation is the permission decision source (superadmin / cube-admin) on the
        // target -- target-row owners and plain grantees are not moderators. ---
        deleteComment: ({ path }: { path: { id: string } }) =>
          Effect.gen(function* () {
            yield* requirePermission(ROUTES.deleteComment)
            const registry = yield* Registry
            const user = yield* CurrentUser
            const c = yield* gatedComment(registry, user, path.id)
            const mod = yield* decision(user, c, "delete")
            if (moderatorDecision(mod)) {
              const removed = yield* comments.remove(path.id, true)
              if (!removed) {
                return yield* Effect.fail(new Forbidden({ message: "no such comment", needed: ROUTES.deleteComment }))
              }
              return removed
            }
            const own = yield* decision(user, c, "edit")
            const authority = commentAuthority(c, user.id, false, own.allowed)
            if (authority !== "owner") {
              return yield* Effect.fail(
                new Forbidden({
                  message: "only the author or a moderator may delete a comment",
                  needed: ROUTES.deleteComment,
                }),
              )
            }
            const removed = yield* comments.remove(path.id, false)
            if (!removed) {
              return yield* Effect.fail(new Forbidden({ message: "no such comment", needed: ROUTES.deleteComment }))
            }
            return removed
          }),
      },
    }
  },
})
