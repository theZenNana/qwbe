export const EntityActions = ["read", "create", "edit", "delete", "share", "transfer"] as const
export type EntityAction = (typeof EntityActions)[number]

export type PermissionActor = Readonly<{ userId: string; roles: ReadonlyArray<string> }>
export type EntityRef = Readonly<{ cube: string; entityType: string; entityId: string }>
export type Ownership = EntityRef & Readonly<{ ownerId: string; createdBy: string; createdAt: string }>
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
export type PermissionGroup = Readonly<{ id: string; cube: string; name: string; createdBy: string; createdAt: string }>
export type CubeAdmin = Readonly<{ id: string; cube: string; userId: string }>
export type GroupMembership = Readonly<{
  id: string
  groupId: string
  userId: string
  createdBy: string
  createdAt: string
}>
export type GrantSubject = Readonly<{ kind: "user"; userId: string }> | Readonly<{ kind: "group"; groupId: string }>
export const TotalActions: ReadonlyArray<EntityAction> = [...EntityActions]
export type EntityGrant = EntityRef &
  Readonly<{
    id: string
    subject: GrantSubject
    actions: ReadonlyArray<EntityAction>
    createdBy: string
    createdAt: string
  }>
export type VisibilityView =
  | "all"
  | "owned-by-me"
  | "created-by-me"
  | "only-mine"
  | "shared-by-me"
  | "shared-with-me"
  | "hidden-by-me"
export type AccessProvenance = Readonly<{
  source: "owner" | "creator" | "user-grant" | "group-grant" | "cube-admin" | "superadmin"
  name: string
  actions: ReadonlyArray<EntityAction>
}>
export type EntityVisibility = EntityRef &
  Readonly<{
    ownerId: string
    createdBy: string
    createdAt: string
    access: AccessProvenance
    hidden: boolean
    sharedWithCount: number
  }>

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
