import type { Effect } from "effect"
import type {
  AccessDecision,
  AuditEvent,
  AuditQuery,
  CubeAdmin,
  EntityAction,
  EntityGrant,
  EntityRef,
  EntityVisibility,
  GroupMembership,
  Ownership,
  PermissionActor,
  PermissionGroup,
  VisibilityView,
} from "./permissions-model.ts"
import type { GrantAction } from "./permissions-schemas.ts"

export type IdentityDirectory = Readonly<{
  resolveUsername: (username: string) => Effect.Effect<{ readonly id: string; readonly username: string } | undefined>
}>

export type PermissionService = Readonly<{
  claim: (actor: PermissionActor, ref: EntityRef) => Effect.Effect<Ownership, string>
  ownership: (ref: EntityRef) => Effect.Effect<Ownership | undefined>
  authorize: (actor: PermissionActor, ref: EntityRef, action: EntityAction) => Effect.Effect<AccessDecision>
  assignCubeAdmin: (actor: PermissionActor, cube: string, userId: string) => Effect.Effect<void, string>
  cubeAdmins: (actor: PermissionActor, cube: string) => Effect.Effect<ReadonlyArray<CubeAdmin>, string>
  transferOwnership: (actor: PermissionActor, ref: EntityRef, userId: string) => Effect.Effect<Ownership, string>
  audit: (query?: AuditQuery) => Effect.Effect<ReadonlyArray<AuditEvent>>
  createGroup: (actor: PermissionActor, cube: string, name: string) => Effect.Effect<PermissionGroup, string>
  renameGroup: (actor: PermissionActor, groupId: string, name: string) => Effect.Effect<PermissionGroup, string>
  groups: (actor: PermissionActor, cube: string) => Effect.Effect<ReadonlyArray<PermissionGroup>, string>
  addGroupMember: (actor: PermissionActor, groupId: string, userId: string) => Effect.Effect<GroupMembership, string>
  removeGroupMember: (actor: PermissionActor, groupId: string, userId: string) => Effect.Effect<void, string>
  grantUser: (
    actor: PermissionActor,
    ref: EntityRef,
    userId: string,
    actions?: ReadonlyArray<GrantAction>,
  ) => Effect.Effect<EntityGrant, string>
  grantGroup: (
    actor: PermissionActor,
    ref: EntityRef,
    groupId: string,
    actions: ReadonlyArray<GrantAction>,
  ) => Effect.Effect<EntityGrant, string>
  revokeGrant: (actor: PermissionActor, grantId: string) => Effect.Effect<void, string>
  listVisible: (
    actor: PermissionActor,
    cube: string,
    view: VisibilityView,
  ) => Effect.Effect<ReadonlyArray<EntityVisibility>>
  setHidden: (actor: PermissionActor, ref: EntityRef, hidden: boolean) => Effect.Effect<EntityVisibility, string>
}>
