import { Effect } from "effect"
import type { IdentityDirectory, PermissionService } from "./permissions-contracts.ts"
import { PermissionInvalid } from "./permissions-contracts.ts"

const unavailable = () => Effect.fail(new PermissionInvalid({ message: "entity permissions provider unavailable" }))

export const lateBoundIdentityDirectory = (holder: { current?: IdentityDirectory }): IdentityDirectory => ({
  resolveUsername: (username) =>
    holder.current ? holder.current.resolveUsername(username) : Effect.succeed(undefined),
})

export const lateBoundPermissionService = (holder: { current?: PermissionService }): PermissionService => ({
  claim: (actor, ref) => (holder.current ? holder.current.claim(actor, ref) : unavailable()),
  ownership: (ref) => (holder.current ? holder.current.ownership(ref) : Effect.succeed(undefined)),
  authorize: (actor, ref, action) =>
    holder.current ? holder.current.authorize(actor, ref, action) : Effect.succeed({ allowed: false, source: "none" }),
  assignCubeAdmin: (actor, cube, userId) =>
    holder.current ? holder.current.assignCubeAdmin(actor, cube, userId) : unavailable(),
  revokeCubeAdmin: (actor, cube, userId) =>
    holder.current ? holder.current.revokeCubeAdmin(actor, cube, userId) : unavailable(),
  cubeAdmins: (actor, cube) => (holder.current ? holder.current.cubeAdmins(actor, cube) : unavailable()),
  transferOwnership: (actor, ref, userId) =>
    holder.current ? holder.current.transferOwnership(actor, ref, userId) : unavailable(),
  audit: (query) => (holder.current ? holder.current.audit(query) : Effect.succeed([])),
  createGroup: (actor, cube, name) => (holder.current ? holder.current.createGroup(actor, cube, name) : unavailable()),
  renameGroup: (actor, groupId, name) =>
    holder.current ? holder.current.renameGroup(actor, groupId, name) : unavailable(),
  groups: (actor, cube) => (holder.current ? holder.current.groups(actor, cube) : unavailable()),
  addGroupMember: (actor, groupId, userId) =>
    holder.current ? holder.current.addGroupMember(actor, groupId, userId) : unavailable(),
  removeGroupMember: (actor, groupId, userId) =>
    holder.current ? holder.current.removeGroupMember(actor, groupId, userId) : unavailable(),
  grantUser: (actor, ref, userId, actions) =>
    holder.current ? holder.current.grantUser(actor, ref, userId, actions) : unavailable(),
  grantGroup: (actor, ref, groupId, actions) =>
    holder.current ? holder.current.grantGroup(actor, ref, groupId, actions) : unavailable(),
  revokeGrant: (actor, grantId) => (holder.current ? holder.current.revokeGrant(actor, grantId) : unavailable()),
  listGrants: (actor, ref) => (holder.current ? holder.current.listGrants(actor, ref) : unavailable()),
  listVisible: (actor, cube, view) =>
    holder.current ? holder.current.listVisible(actor, cube, view) : Effect.succeed([]),
  setHidden: (actor, ref, hidden) => (holder.current ? holder.current.setHidden(actor, ref, hidden) : unavailable()),
})
