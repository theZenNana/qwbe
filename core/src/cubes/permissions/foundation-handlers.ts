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
import type { auditFrom } from "./audit.ts"
import { actorFrom, mapPermissionError, resolveIdentity } from "./handler-utils.ts"

const readError = mapPermissionError("permissions:read")
const transferError = mapPermissionError("permissions:transfer")
const writeError = mapPermissionError("permissions:write")

const currentActor = Effect.map(CurrentUser, actorFrom)

export const foundationHandlers = (
  service: Pick<PermissionService, "assignCubeAdmin" | "revokeCubeAdmin" | "cubeAdmins" | "transferOwnership">,
  identities: IdentityDirectory | undefined,
  auditPage: ReturnType<typeof auditFrom>["auditPage"],
) => ({
  assignPermissionCubeAdmin: ({ payload }: { payload: typeof CubeAdminAssign.Type }) =>
    Effect.gen(function* () {
      const actor = yield* currentActor
      const identity = yield* resolveIdentity(identities, payload.username)
      yield* service.assignCubeAdmin(actor, payload.cube, identity.id).pipe(writeError)
      return { assigned: identity.id }
    }),
  revokePermissionCubeAdmin: ({ path }: { path: { cube: string; username: string } }) =>
    Effect.gen(function* () {
      const actor = yield* currentActor
      const identity = yield* resolveIdentity(identities, path.username)
      yield* service.revokeCubeAdmin(actor, path.cube, identity.id).pipe(writeError)
      return { revoked: identity.id }
    }),
  permissionCubeAdmins: ({ urlParams }: { urlParams: { cube: string } }) =>
    Effect.gen(function* () {
      const actor = yield* currentActor
      return yield* service.cubeAdmins(actor, urlParams.cube).pipe(readError)
    }),
  transferPermissionOwnership: ({ path, payload }: { path: EntityRef; payload: typeof OwnershipTransfer.Type }) =>
    Effect.gen(function* () {
      const actor = yield* currentActor
      const identity = yield* resolveIdentity(identities, payload.username)
      return yield* service.transferOwnership(actor, path, identity.id).pipe(transferError)
    }),
  permissionAudit: ({ urlParams }: { urlParams: typeof AuditQuerySchema.Type }) =>
    Effect.gen(function* () {
      yield* requirePermission("permissions:read")
      return yield* auditPage(urlParams).pipe(readError)
    }),
})
