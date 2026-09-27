// Every type that has a schema is derived from it; the rest have no wire shape.
import {
  type CapabilityGrantSchema,
  type CubeAdminSchema,
  EntityActions,
  type EntityGrantSchema,
  type EntityVisibilitySchema,
  type GrantAction,
  type GrantSubjectSchema,
  type GroupMembershipSchema,
  type OwnershipSchema,
  type PermissionGroupSchema,
  type VisibilityViewSchema,
} from "./permissions-schemas.ts"

export type EntityAction = GrantAction

export type PermissionActor = Readonly<{ userId: string; roles: ReadonlyArray<string> }>
export type EntityRef = Readonly<{ cube: string; entityType: string; entityId: string }>
export type Ownership = typeof OwnershipSchema.Type
export type AccessDecision = Readonly<{
  allowed: boolean
  source: "superadmin" | "cube-admin" | "owner" | "grant" | "none"
}>
export type AuditResult = "allowed" | "denied" | "success"
export type AuditValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<AuditValue>
  | { readonly [key: string]: AuditValue }
export type AuditEvent = Readonly<{
  id: string
  traceId: string
  timestamp: string
  actorUserId: string
  cube: string
  entityType: string
  entityId: string
  action: string
  result: AuditResult
  before: AuditValue
  after: AuditValue
}>
export type AuditQuery = Readonly<{
  actorUserId?: string | undefined
  groupId?: string | undefined
  cube?: string | undefined
  entityType?: string | undefined
  entityId?: string | undefined
  action?: string | undefined
  result?: AuditResult | undefined
  from?: string | undefined
  to?: string | undefined
  offset?: number | undefined
  limit?: number | undefined
}>
export type PermissionGroup = typeof PermissionGroupSchema.Type
export type CubeAdmin = typeof CubeAdminSchema.Type
export type GroupMembership = typeof GroupMembershipSchema.Type
export type GrantSubject = typeof GrantSubjectSchema.Type
export type EntityGrant = typeof EntityGrantSchema.Type
/**
 * A runtime grant of one DECLARED cube permission (`notes:write`) to a user or a group. It
 * adds to what the static roles give and satisfies only the route gate; entity access still
 * needs owner, entity grant, cube admin or superadmin.
 */
export type CapabilityGrant = typeof CapabilityGrantSchema.Type
export type VisibilityView = typeof VisibilityViewSchema.Type
export type EntityVisibility = typeof EntityVisibilitySchema.Type
export type AccessProvenance = EntityVisibility["access"]

export const grantAccess = (
  userId: string,
  groupIds: ReadonlySet<string>,
  grants: ReadonlyArray<EntityGrant>,
): AccessProvenance | undefined => {
  const applicable = grants.filter(
    (grant) =>
      (grant.subject.kind === "user" && grant.subject.userId === userId) ||
      (grant.subject.kind === "group" && groupIds.has(grant.subject.groupId)),
  )
  const actions = EntityActions.filter((action) => applicable.some((grant) => grant.actions.includes(action)))
  if (applicable.some((grant) => grant.subject.kind === "user")) return { source: "user-grant", name: userId, actions }
  const groups = applicable.flatMap((grant) => (grant.subject.kind === "group" ? [grant.subject.groupId] : []))
  return groups.length > 0 ? { source: "group-grant", name: groups.join(", "), actions } : undefined
}

export const matchesVisibilityView = (row: EntityVisibility, userId: string, view: VisibilityView): boolean => {
  if (view === "all") return !row.hidden
  if (view === "owned-by-me") return row.ownerId === userId && !row.hidden
  if (view === "created-by-me") return row.createdBy === userId && !row.hidden
  if (view === "only-mine") return row.ownerId === userId && row.sharedWithCount === 0 && !row.hidden
  if (view === "shared-by-me") return row.ownerId === userId && row.sharedWithCount > 0 && !row.hidden
  if (view === "shared-with-me") return row.ownerId !== userId && !row.hidden
  return row.hidden
}
