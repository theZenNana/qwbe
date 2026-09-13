// The store contract, declared as a leaf module (QWB-70): pg/store.ts, pg/batch.ts,
// pg/activity.ts and registry.ts name these types without importing kernel/manifest.ts,
// which would close a cycle through kernel/registry.ts and kernel/store.ts. manifest.ts
// re-exports them so the public surface is unchanged.

import type { Effect } from "effect"
import type { ListWhere, Page, PageRequest } from "./pagination.ts"

/**
 * Current state of one captured row (echo feed's delete-vs-missing resolver). Lives with the
 * store contract it describes; pg/store.ts provides the implementation (`rowStateFor`).
 */
export type RowState = { readonly id: string; readonly type: string; readonly deleted: boolean }

export type CubeStore = {
  readonly all: <A>(table: string) => Effect.Effect<ReadonlyArray<A>, never, never>
  /** Real SQL paging: LIMIT/OFFSET plus a COUNT, not a slice taken in memory. */
  readonly page: <A>(
    table: string,
    page: PageRequest,
    /** One pair or the full ListWhere. */
    where?: { readonly field: string; readonly value: string } | ListWhere,
  ) => Effect.Effect<Page<A>, never, never>
  readonly byId: <A>(table: string, id: string) => Effect.Effect<A | undefined, never, never>
  readonly insert: (
    table: string,
    entityType: string,
    prefix: string,
    values: Record<string, unknown>,
  ) => Effect.Effect<Record<string, unknown>, never, never>
  readonly update: (
    table: string,
    id: string,
    patch: Record<string, unknown>,
  ) => Effect.Effect<Record<string, unknown> | undefined, never, never>
  readonly count: (table: string) => Effect.Effect<number, never, never>
}
export type ActivityRow = {
  readonly id: number
  readonly at: string
  readonly cube: string
  readonly entityType: string
  readonly rowId: string
  readonly op: string
  readonly version: number | null
  readonly actorId: string | null
  readonly actorUsername: string | null
  readonly changes: Record<string, { from?: unknown; to?: unknown }> | null
  readonly commentId: string | null
  /** Filled from qwbe.comment (page's LEFT JOIN); null unless `op` is "comment". */
  readonly comment: CommentRow | null
}
export type CommentRow = {
  readonly id: string
  readonly cube: string
  readonly entityType: string
  readonly rowId: string
  readonly actorId: string | null
  readonly actorUsername: string | null
  readonly body: string
  readonly createdAt: string
  readonly editedAt: string | null
  readonly deletedAt: string | null
  readonly deletedBy: string | null
}
export type ActivityTools = {
  readonly page: (query: {
    readonly cube?: string
    readonly entityType?: string
    readonly entityId?: string
    readonly beforeId?: number
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<ActivityRow>, never, never>
  /**
   * Echo A2 comments. Held by the same single `readsActivity` holder as `page`; the comment
   * row and its linked activity row are written in ONE transaction, with `op` forced to
   * "comment", `changes` to "{}" and `version` to NULL, so this seam cannot forge a mutation
   * event. The actor comes from the `CurrentActor` FiberRef, never a parameter.
   */
  readonly comments: {
    readonly add: (
      target: { readonly cube: string; readonly entityType: string; readonly entityId: string },
      body: string,
    ) => Effect.Effect<ActivityRow, never, never>
    readonly byId: (id: string) => Effect.Effect<CommentRow | undefined, never, never>
    /** Always the AUTHOR's own row: UPDATE ... WHERE id = $1 AND actor_id = <CurrentActor.id>.
     * There is no moderator edit; nobody edits another person's words. Refuses (undefined) an
     * already-deleted comment. */
    readonly edit: (id: string, body: string) => Effect.Effect<CommentRow | undefined, never, never>
    /** moderator=false pins actor_id to the current actor; true (superadmin / cube-admin on
     * the target) matches any live row. Wipes the body in place either way. */
    readonly remove: (id: string, moderator: boolean) => Effect.Effect<CommentRow | undefined, never, never>
  }
}
