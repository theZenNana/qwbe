import { Effect } from "effect"
import { CurrentUser, requirePermission } from "qwbe-core/auth"
import type {
  AuditQuerySchema,
  CubeAdminAssign,
  EntityRef,
  IdentityDirectory,
  OwnershipTransfer,
  PermissionService,
} from "qwbe-core/permissions"
import { actorFrom, forbidden, resolveIdentity } from "./handler-utils.ts"

export const foundationHandlers = (service: PermissionService, identities: IdentityDirectory | undefined) => ({
  assignPermissionCubeAdmin: ({ payload }: { payload: typeof CubeAdminAssign.Type }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const identity = yield* resolveIdentity(identities, payload.username, "permissions:write")
      yield* service
        .assignCubeAdmin(actorFrom(user), payload.cube, identity.id)
        .pipe(Effect.mapError(forbidden("permissions:write")))
      return { assigned: identity.id }
    }),
  permissionCubeAdmins: ({ urlParams }: { urlParams: { cube: string } }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      return yield* service
        .cubeAdmins(actorFrom(user), urlParams.cube)
        .pipe(Effect.mapError(forbidden("permissions:read")))
    }),
  transferPermissionOwnership: ({ path, payload }: { path: EntityRef; payload: typeof OwnershipTransfer.Type }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const identity = yield* resolveIdentity(identities, payload.username, "permissions:transfer")
      return yield* service
        .transferOwnership(actorFrom(user), path, identity.id)
        .pipe(Effect.mapError(forbidden("permissions:transfer")))
    }),
  permissionAudit: ({ urlParams }: { urlParams: typeof AuditQuerySchema.Type }) =>
    Effect.gen(function* () {
      yield* requirePermission("permissions:read")
      const rows = [...(yield* service.audit(urlParams))].sort((left, right) =>
        right.timestamp.localeCompare(left.timestamp),
      )
      return {
        rows: rows.slice(urlParams.offset, urlParams.offset + urlParams.limit),
        total: rows.length,
        offset: urlParams.offset,
        limit: urlParams.limit,
        sortedBy: "timestamp",
      }
    }),
})
