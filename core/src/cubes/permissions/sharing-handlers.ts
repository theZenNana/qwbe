import { Effect } from "effect"
import { CurrentUser } from "qwbe-core/auth"
import type {
  EntityRef,
  GroupCreate,
  GroupGrantCreate,
  GroupRename,
  IdentityDirectory,
  MemberRemove,
  MembershipCreate,
  PermissionService,
  UserGrantCreate,
} from "qwbe-core/permissions"
import { actorFrom, forbidden, resolveIdentity } from "./handler-utils.ts"

export const sharingHandlers = (service: PermissionService, identities: IdentityDirectory | undefined) => ({
  createPermissionGroup: ({ payload }: { payload: typeof GroupCreate.Type }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      return yield* service
        .createGroup(actorFrom(user), payload.cube, payload.name)
        .pipe(Effect.mapError(forbidden("permissions:group")))
    }),
  permissionGroups: ({ urlParams }: { urlParams: { cube: string } }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      return yield* service
        .groups(actorFrom(user), urlParams.cube)
        .pipe(Effect.mapError(forbidden("permissions:group")))
    }),
  renamePermissionGroup: ({ path, payload }: { path: { groupId: string }; payload: typeof GroupRename.Type }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      return yield* service
        .renameGroup(actorFrom(user), path.groupId, payload.name)
        .pipe(Effect.mapError(forbidden("permissions:group")))
    }),
  addPermissionGroupMember: ({ path, payload }: { path: { groupId: string }; payload: typeof MembershipCreate.Type }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const identity = yield* resolveIdentity(identities, payload.username, "permissions:group")
      return yield* service
        .addGroupMember(actorFrom(user), path.groupId, identity.id)
        .pipe(Effect.mapError(forbidden("permissions:group")))
    }),
  removePermissionGroupMember: ({ path, payload }: { path: { groupId: string }; payload: typeof MemberRemove.Type }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const identity = yield* resolveIdentity(identities, payload.username, "permissions:group")
      yield* service
        .removeGroupMember(actorFrom(user), path.groupId, identity.id)
        .pipe(Effect.mapError(forbidden("permissions:group")))
      return { removed: identity.id }
    }),
  grantPermissionUser: ({ path, payload }: { path: EntityRef; payload: typeof UserGrantCreate.Type }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const identity = yield* resolveIdentity(identities, payload.username, "permissions:share")
      return yield* service
        .grantUser(actorFrom(user), path, identity.id, payload.actions)
        .pipe(Effect.mapError(forbidden("permissions:share")))
    }),
  grantPermissionGroup: ({ path, payload }: { path: EntityRef; payload: typeof GroupGrantCreate.Type }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      return yield* service
        .grantGroup(actorFrom(user), path, payload.groupId, payload.actions)
        .pipe(Effect.mapError(forbidden("permissions:share")))
    }),
  revokePermissionGrant: ({ path }: { path: { grantId: string } }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      yield* service.revokeGrant(actorFrom(user), path.grantId).pipe(Effect.mapError(forbidden("permissions:share")))
      return { revoked: path.grantId }
    }),
})
