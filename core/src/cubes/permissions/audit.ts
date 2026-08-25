import { Effect, Schema } from "effect"
import {
  AuditEventSchema,
  type AuditQuery,
  matchesAuditQuery,
  PermissionInvalid,
  type PermissionService,
} from "qwbe-core/permissions"
import type { PermissionState } from "./state.ts"
import { tables } from "./state.ts"

export const auditFrom = (state: PermissionState): Pick<PermissionService, "audit"> => ({
  audit: (query: AuditQuery = {}) =>
    Effect.gen(function* () {
      const stored = yield* state.store.all<unknown>(tables.audit)
      const events = yield* Effect.forEach(stored, (event) =>
        Schema.decodeUnknown(AuditEventSchema)(event).pipe(
          Effect.mapError(() => new PermissionInvalid({ message: "stored audit event violates its runtime schema" })),
        ),
      )
      return events.filter((event) => matchesAuditQuery(event, query))
    }),
})
