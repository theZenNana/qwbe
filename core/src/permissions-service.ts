import type { Effect } from "effect"
import type { PermissionServiceError } from "./permissions-errors.ts"
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
  claim: (actor: PermissionActor, ref: EntityRef) => Effect.Effect<Ownership, PermissionServiceError>
  ownership: (ref: EntityRef) => Effect.Effect<Ownership | undefined>
  authorize: (
    actor: PermissionActor,
    ref: EntityRef,
    action: EntityAction,
  ) => Effect.Effect<AccessDecision, PermissionServiceError>
  assignCubeAdmin: (actor: PermissionActor, cube: string, userId: string) => Effect.Effect<void, PermissionServiceError>
  revokeCubeAdmin: (actor: PermissionActor, cube: string, userId: string) => Effect.Effect<void, PermissionServiceError>
  cubeAdmins: (actor: PermissionActor, cube: string) => Effect.Effect<ReadonlyArray<CubeAdmin>, PermissionServiceError>
  transferOwnership: (
    actor: PermissionActor,
    ref: EntityRef,
    userId: string,
  ) => Effect.Effect<Ownership, PermissionServiceError>
  audit: (query?: AuditQuery) => Effect.Effect<ReadonlyArray<AuditEvent>, PermissionServiceError>
  createGroup: (
    actor: PermissionActor,
    cube: string,
    name: string,
  ) => Effect.Effect<PermissionGroup, PermissionServiceError>
  renameGroup: (
    actor: PermissionActor,
    groupId: string,
    name: string,
  ) => Effect.Effect<PermissionGroup, PermissionServiceError>
  groups: (
    actor: PermissionActor,
    cube: string,
  ) => Effect.Effect<ReadonlyArray<PermissionGroup>, PermissionServiceError>
  addGroupMember: (
    actor: PermissionActor,
    groupId: string,
    userId: string,
  ) => Effect.Effect<GroupMembership, PermissionServiceError>
  removeGroupMember: (
    actor: PermissionActor,
    groupId: string,
    userId: string,
  ) => Effect.Effect<void, PermissionServiceError>
  grantUser: (
    actor: PermissionActor,
    ref: EntityRef,
    userId: string,
    actions?: ReadonlyArray<GrantAction>,
  ) => Effect.Effect<EntityGrant, PermissionServiceError>
  grantGroup: (
    actor: PermissionActor,
    ref: EntityRef,
    groupId: string,
    actions: ReadonlyArray<GrantAction>,
  ) => Effect.Effect<EntityGrant, PermissionServiceError>
  revokeGrant: (actor: PermissionActor, grantId: string) => Effect.Effect<void, PermissionServiceError>
  listGrants: (
    actor: PermissionActor,
    ref: EntityRef,
  ) => Effect.Effect<ReadonlyArray<EntityGrant>, PermissionServiceError>
  listVisible: (
    actor: PermissionActor,
    cube: string,
    view: VisibilityView,
  ) => Effect.Effect<ReadonlyArray<EntityVisibility>>
  setHidden: (
    actor: PermissionActor,
    ref: EntityRef,
    hidden: boolean,
  ) => Effect.Effect<EntityVisibility, PermissionServiceError>
}>
