import { Effect } from "effect"
import type { IdentityDirectory, PermissionService } from "./permissions-contracts.ts"

export const lateBoundIdentityDirectory = (holder: { current?: IdentityDirectory }): IdentityDirectory => ({
  resolveUsername: (username) =>
    holder.current ? holder.current.resolveUsername(username) : Effect.succeed(undefined),
})

export const lateBoundPermissionService = (holder: { current?: PermissionService }): PermissionService => ({
  claim: (actor, ref) =>
    holder.current ? holder.current.claim(actor, ref) : Effect.fail("entity permissions provider unavailable"),
  ownership: (ref) => (holder.current ? holder.current.ownership(ref) : Effect.succeed(undefined)),
  authorize: (actor, ref, action) =>
    holder.current ? holder.current.authorize(actor, ref, action) : Effect.succeed({ allowed: false, source: "none" }),
  assignCubeAdmin: (actor, cube, userId) =>
    holder.current
      ? holder.current.assignCubeAdmin(actor, cube, userId)
      : Effect.fail("entity permissions provider unavailable"),
  cubeAdmins: (actor, cube) =>
    holder.current ? holder.current.cubeAdmins(actor, cube) : Effect.fail("entity permissions provider unavailable"),
  transferOwnership: (actor, ref, userId) =>
    holder.current
      ? holder.current.transferOwnership(actor, ref, userId)
      : Effect.fail("entity permissions provider unavailable"),
  audit: (query) => (holder.current ? holder.current.audit(query) : Effect.succeed([])),
  createGroup: (actor, cube, name) =>
    holder.current
      ? holder.current.createGroup(actor, cube, name)
      : Effect.fail("entity permissions provider unavailable"),
  renameGroup: (actor, groupId, name) =>
    holder.current
      ? holder.current.renameGroup(actor, groupId, name)
      : Effect.fail("entity permissions provider unavailable"),
  groups: (actor, cube) =>
    holder.current ? holder.current.groups(actor, cube) : Effect.fail("entity permissions provider unavailable"),
  addGroupMember: (actor, groupId, userId) =>
    holder.current
      ? holder.current.addGroupMember(actor, groupId, userId)
      : Effect.fail("entity permissions provider unavailable"),
  removeGroupMember: (actor, groupId, userId) =>
    holder.current
      ? holder.current.removeGroupMember(actor, groupId, userId)
      : Effect.fail("entity permissions provider unavailable"),
  grantUser: (actor, ref, userId, actions) =>
    holder.current
      ? holder.current.grantUser(actor, ref, userId, actions)
      : Effect.fail("entity permissions provider unavailable"),
  grantGroup: (actor, ref, groupId, actions) =>
    holder.current
      ? holder.current.grantGroup(actor, ref, groupId, actions)
      : Effect.fail("entity permissions provider unavailable"),
  revokeGrant: (actor, grantId) =>
    holder.current
      ? holder.current.revokeGrant(actor, grantId)
      : Effect.fail("entity permissions provider unavailable"),
  listVisible: (actor, cube, view) =>
    holder.current ? holder.current.listVisible(actor, cube, view) : Effect.succeed([]),
  setHidden: (actor, ref, hidden) =>
    holder.current
      ? holder.current.setHidden(actor, ref, hidden)
      : Effect.fail("entity permissions provider unavailable"),
})
