import { Effect, Schema } from "effect"
import type { PageResponse } from "qwbe-core/http"
import { pageRequest } from "qwbe-core/pagination"
import {
  type AuditEvent,
  AuditEventSchema,
  type AuditQuery,
  matchesAuditQuery,
  PermissionInvalid,
  type PermissionService,
  type PermissionServiceError,
} from "qwbe-core/permissions"
import { page } from "./handler-utils.ts"
import type { PermissionState } from "./state.ts"
import { tables } from "./state.ts"

const EQUAL_FIELDS = ["actorUserId", "cube", "entityType", "entityId", "action", "result"] as const

/** Every filter of `query` except `groupId`, as SQL: equalities and the timestamp range. */
const whereOf = (query: AuditQuery) => ({
  equals: EQUAL_FIELDS.flatMap((field) => (query[field] ? [{ field, value: query[field] }] : [])),
  range: { field: "timestamp", from: query.from || undefined, to: query.to || undefined },
})

const decodeEvents = (stored: ReadonlyArray<unknown>) =>
  Effect.forEach(stored, (event) =>
    Schema.decodeUnknown(AuditEventSchema)(event).pipe(
      Effect.mapError(() => new PermissionInvalid({ message: "stored audit event violates its runtime schema" })),
    ),
  )

export const auditFrom = (
  state: PermissionState,
): Pick<PermissionService, "audit"> & {
  /** Newest first, filtered and paged in SQL; only the returned page is decoded. */
  readonly auditPage: (query: AuditQuery) => Effect.Effect<PageResponse<AuditEvent>, PermissionServiceError>
} => {
  const matching = (stored: ReadonlyArray<unknown>, query: AuditQuery) =>
    Effect.map(decodeEvents(stored), (events) => events.filter((event) => matchesAuditQuery(event, query)))
  return {
    audit: (query: AuditQuery = {}) =>
      Effect.flatMap(state.store.all<unknown>(tables.audit), (stored) => matching(stored, query)),
    auditPage: (query) => {
      const { offset, limit } = pageRequest(query)
      // ponytail: `groupId` searches the before/after JSON at any depth, so it stays in memory over
      // the rows the other filters leave, then pages in memory. Ceiling: a groupId query reads every
      // such row; move it to SQL (jsonb_path_exists) when that shows up in a profile.
      if (query.groupId) {
        return Effect.gen(function* () {
          const events = yield* matching(yield* state.store.where<unknown>(tables.audit, whereOf(query)), query)
          const newest = [...events].sort((left, right) => right.timestamp.localeCompare(left.timestamp))
          return page(newest, offset, limit, "timestamp")
        })
      }
      return Effect.gen(function* () {
        const found = yield* state.store.page<unknown>(
          tables.audit,
          { offset, limit, sortBy: "timestamp", descending: true },
          whereOf(query),
        )
        return { ...found, rows: yield* decodeEvents(found.rows) }
      })
    },
  }
}
