// Echo A2 (read feed only) -- pure visibility decision for activity rows.
//
// The feed NEVER trusts a row's own claim about its target. Every row must pass four
// independent gates, each checked against CURRENT kernel state, each failing closed:
//
//   1. `capture`   -- the target cube is mounted, enabled, and currently captures the row's
//                     declared entity type (`Registry.captureOf`). Excludes identity
//                     directories (they never capture) and cubes whose declared entity
//                     changed after the row was written.
//   2. `readCap`   -- a REAL read route capability: the target cube's mounted route metadata
//                     publishes a CANONICAL read route (`get`, falling back to `list`) whose
//                     declared permission the caller holds. Any other GET route proves
//                     nothing.
//                     Entity-level read alone is not enough -- `Registry.summary` enforces
//                     only the entity gate (and skips it entirely for permission-exempt
//                     entries), so the route cap is checked here, separately, for everyone
//                     including admin.
//   3. `target`    -- `Registry.summary(entity, id, caller)` is defined: the row's target
//                     currently exists, is not deleted, and the caller passes the entity
//                     read gate. Undefined is ambiguous (missing / deleted / disabled /
//                     denied) and is NEVER read as "deleted"; the one way through it is the
//                     deleted-history rule in index.ts (`Registry.targetState` says deleted
//                     now, and the caller is a superadmin or cube-admin of the target).
//
// Cursor safety lives in `visiblePage`: the cursor advances by the LAST SCANNED row, so a
// page full of hidden rows still moves forward and cannot loop or skip.

import type { ActivityRow, CommentRow } from "../../kernel/manifest.ts"

/** Everything the feed knows about one target cube, all of it resolved before any row read. */
export type FeedTargetMeta = {
  /** Current capture entity of the cube, or undefined when it captures nothing right now. */
  readonly capture: string | undefined
  /** The read-route permission the caller provably holds via mounted route metadata, or null. */
  readonly readCap: string | null
}

export type FeedRouteMeta = {
  readonly method: string
  readonly permission: string | null
}

/**
 * The CANONICAL read-route capability of one cube, read from its MOUNTED route metadata:
 * the single-row `get` route, falling back to `list` (the kernel's read convention, which
 * `validateRoutes` forbids to opt out). Any other GET route proves nothing about reading
 * rows. `permission: null` is the manifest's explicit per-request opt-out (not a denial and
 * not a missing declaration); the feed cannot replay a per-request decision from metadata,
 * so it has no static proof and returns null.
 */
export const readRouteCap = (
  routes: Readonly<Record<string, FeedRouteMeta>> | undefined,
  permissions: ReadonlyArray<string>,
): string | null => {
  const route = routes?.get ?? routes?.list
  if (route === undefined || route.method !== "GET" || route.permission === null) return null
  return permissions.includes(route.permission) ? route.permission : null
}

/** The full visibility decision. `targetVisible` is resolved by the caller (Effectful). */
export const feedRowVisible = (
  meta: FeedTargetMeta,
  row: Pick<ActivityRow, "cube" | "entityType">,
  targetVisible: boolean,
): boolean => meta.capture !== undefined && meta.capture === row.entityType && meta.readCap !== null && targetVisible

/**
 * Filter a scanned page and produce the safe cursor. `nextBefore` is the id of the LAST
 * SCANNED row -- visible or not -- so paging always advances; an empty scan yields null
 * (nothing more to ask for).
 */
export const visiblePage = (
  scanned: ReadonlyArray<ActivityRow>,
  isVisible: (row: ActivityRow) => boolean,
): { readonly rows: Array<ActivityRow>; readonly nextBefore: number | null } => ({
  rows: scanned.filter((row) => isVisible(row)),
  nextBefore: scanned.length > 0 ? scanned[scanned.length - 1]!.id : null,
})

/**
 * Who may act on ONE comment, given facts the caller resolved against CURRENT state:
 *
 *   - `moderator`   -- the caller's entity decision on the TARGET came back with source
 *                      "superadmin" or "cube-admin" (the permission foundation is the one
 *                      decision source; target-row owners and plain grantees are NOT
 *                      moderators). Moderators DELETE only: nobody edits another person's
 *                      words, not even a superadmin.
 *   - `targetEditable` -- the target currently passes the comment gate for the caller
 *                      (read route held, summary live, entity edit allowed). Revoking target
 *                      access revokes comment authority with it.
 *
 * "owner" covers the author's own comment (edit AND delete); "moderator" deletes only.
 * A deleted comment never reaches here -- the handler refuses it before asking.
 */
export const commentAuthority = (
  comment: Pick<CommentRow, "actorId">,
  userId: string,
  moderator: boolean,
  targetEditable: boolean,
): "owner" | "moderator" | "denied" =>
  moderator ? "moderator" : comment.actorId === userId && targetEditable ? "owner" : "denied"
