import { Effect } from "effect"
import { CurrentUser } from "qwbe-core/auth"
import type {
  EntityGrantListParams,
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
import { actorFrom, mapPermissionError, resolveIdentity } from "./handler-utils.ts"

const groupError = mapPermissionError("permissions:group")
const shareError = mapPermissionError("permissions:share")

export const sharingHandlers = (service: PermissionService, identities: IdentityDirectory | undefined) => ({
  createPermissionGroup: ({ payload }: { payload: typeof GroupCreate.Type }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      return yield* service.createGroup(actorFrom(user), payload.cube, payload.name).pipe(groupError)
    }),
  permissionGroups: ({ urlParams }: { urlParams: { cube: string } }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      return yield* service.groups(actorFrom(user), urlParams.cube).pipe(groupError)
    }),
  renamePermissionGroup: ({ path, payload }: { path: { groupId: string }; payload: typeof GroupRename.Type }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      return yield* service.renameGroup(actorFrom(user), path.groupId, payload.name).pipe(groupError)
    }),
  addPermissionGroupMember: ({ path, payload }: { path: { groupId: string }; payload: typeof MembershipCreate.Type }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const identity = yield* resolveIdentity(identities, payload.username)
      return yield* service.addGroupMember(actorFrom(user), path.groupId, identity.id).pipe(groupError)
    }),
  removePermissionGroupMember: ({ path, payload }: { path: { groupId: string }; payload: typeof MemberRemove.Type }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const identity = yield* resolveIdentity(identities, payload.username)
      yield* service.removeGroupMember(actorFrom(user), path.groupId, identity.id).pipe(groupError)
      return { removed: identity.id }
    }),
  grantPermissionUser: ({ path, payload }: { path: EntityRef; payload: typeof UserGrantCreate.Type }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const identity = yield* resolveIdentity(identities, payload.username)
      return yield* service.grantUser(actorFrom(user), path, identity.id, payload.actions).pipe(shareError)
    }),
  grantPermissionGroup: ({ path, payload }: { path: EntityRef; payload: typeof GroupGrantCreate.Type }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      return yield* service.grantGroup(actorFrom(user), path, payload.groupId, payload.actions).pipe(shareError)
    }),
  revokePermissionGrant: ({ path }: { path: { grantId: string } }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      yield* service.revokeGrant(actorFrom(user), path.grantId).pipe(shareError)
      return { revoked: path.grantId }
    }),
  permissionEntityGrants: ({ path, urlParams }: { path: EntityRef; urlParams: typeof EntityGrantListParams.Type }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const rows = yield* service.listGrants(actorFrom(user), path).pipe(shareError)
      return {
        rows: rows.slice(urlParams.offset, urlParams.offset + urlParams.limit),
        total: rows.length,
        offset: urlParams.offset,
        limit: urlParams.limit,
        sortedBy: "createdAt",
      }
    }),
})
