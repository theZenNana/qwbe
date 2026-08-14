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
  before: unknown
  after: unknown
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
    access: AccessProvenance
    hidden: boolean
    sharedWithCount: number
  }>
