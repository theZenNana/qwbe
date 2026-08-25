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
import { actorFrom, mapPermissionError, resolveIdentity } from "./handler-utils.ts"

const readError = mapPermissionError("permissions:read")
const transferError = mapPermissionError("permissions:transfer")
const writeError = mapPermissionError("permissions:write")

export const foundationHandlers = (service: PermissionService, identities: IdentityDirectory | undefined) => ({
  assignPermissionCubeAdmin: ({ payload }: { payload: typeof CubeAdminAssign.Type }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const identity = yield* resolveIdentity(identities, payload.username)
      yield* service.assignCubeAdmin(actorFrom(user), payload.cube, identity.id).pipe(writeError)
      return { assigned: identity.id }
    }),
  revokePermissionCubeAdmin: ({ path }: { path: { cube: string; username: string } }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const identity = yield* resolveIdentity(identities, path.username)
      yield* service.revokeCubeAdmin(actorFrom(user), path.cube, identity.id).pipe(writeError)
      return { revoked: identity.id }
    }),
  permissionCubeAdmins: ({ urlParams }: { urlParams: { cube: string } }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      return yield* service.cubeAdmins(actorFrom(user), urlParams.cube).pipe(readError)
    }),
  transferPermissionOwnership: ({ path, payload }: { path: EntityRef; payload: typeof OwnershipTransfer.Type }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const identity = yield* resolveIdentity(identities, payload.username)
      return yield* service.transferOwnership(actorFrom(user), path, identity.id).pipe(transferError)
    }),
  permissionAudit: ({ urlParams }: { urlParams: typeof AuditQuerySchema.Type }) =>
    Effect.gen(function* () {
      yield* requirePermission("permissions:read")
      const rows = [...(yield* service.audit(urlParams).pipe(readError))].sort((left, right) =>
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
