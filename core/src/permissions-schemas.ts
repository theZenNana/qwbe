import { Schema } from "effect"
import { EntityActions, TotalActions } from "./permissions-model.ts"

export const GrantAction = Schema.Literal(...EntityActions)
export type GrantAction = typeof GrantAction.Type
export const PermissionGroupSchema = Schema.Struct({
  id: Schema.String,
  cube: Schema.String,
  name: Schema.String,
  createdBy: Schema.String,
  createdAt: Schema.String,
}).annotations({ identifier: "PermissionGroup" })
export const GroupMembershipSchema = Schema.Struct({
  id: Schema.String,
  groupId: Schema.String,
  userId: Schema.String,
  createdBy: Schema.String,
  createdAt: Schema.String,
}).annotations({ identifier: "GroupMembership" })
export const EntityGrantSchema = Schema.Struct({
  id: Schema.String,
  cube: Schema.String,
  entityType: Schema.String,
  entityId: Schema.String,
  subject: Schema.Union(
    Schema.Struct({ kind: Schema.Literal("user"), userId: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("group"), groupId: Schema.String }),
  ),
  actions: Schema.Array(GrantAction),
  createdBy: Schema.String,
  createdAt: Schema.String,
}).annotations({ identifier: "EntityGrant" })
export const GroupCreate = Schema.Struct({ cube: Schema.String, name: Schema.String }).annotations({
  identifier: "GroupCreate",
})
export const GroupRename = Schema.Struct({ name: Schema.String }).annotations({ identifier: "GroupRename" })
export const OwnershipTransfer = Schema.Struct({ username: Schema.String }).annotations({
  identifier: "OwnershipTransfer",
})
export const OwnershipSchema = Schema.Struct({
  cube: Schema.String,
  entityType: Schema.String,
  entityId: Schema.String,
  ownerId: Schema.String,
  createdBy: Schema.String,
  createdAt: Schema.String,
}).annotations({ identifier: "Ownership" })
export const CubeAdminSchema = Schema.Struct({
  id: Schema.String,
  cube: Schema.String,
  userId: Schema.String,
}).annotations({
  identifier: "CubeAdmin",
})
export const CubeAdminAssign = Schema.Struct({ cube: Schema.String, username: Schema.String }).annotations({
  identifier: "CubeAdminAssign",
})
export const MembershipCreate = Schema.Struct({ username: Schema.String }).annotations({
  identifier: "MembershipCreate",
})
export const GroupListParams = Schema.Struct({ cube: Schema.String })
export const MemberRemove = Schema.Struct({ username: Schema.String }).annotations({ identifier: "MemberRemove" })
export const UserGrantCreate = Schema.Struct({
  username: Schema.String,
  actions: Schema.optionalWith(Schema.Array(GrantAction), { default: () => [...TotalActions] }),
}).annotations({ identifier: "UserGrantCreate" })
export const GroupGrantCreate = Schema.Struct({
  groupId: Schema.String,
  actions: Schema.Array(GrantAction),
}).annotations({
  identifier: "GroupGrantCreate",
})
export const AuditQuerySchema = Schema.Struct({
  actorUserId: Schema.optional(Schema.String),
  groupId: Schema.optional(Schema.String),
  cube: Schema.optional(Schema.String),
  entityType: Schema.optional(Schema.String),
  entityId: Schema.optional(Schema.String),
  action: Schema.optional(Schema.String),
  result: Schema.optional(Schema.Literal("allowed", "denied", "success")),
  from: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String),
  offset: Schema.optionalWith(Schema.NumberFromString, { default: () => 0 }),
  limit: Schema.optionalWith(Schema.NumberFromString, { default: () => 50 }),
})
export const AuditEventSchema = Schema.Struct({
  id: Schema.String,
  traceId: Schema.String,
  timestamp: Schema.String,
  actorUserId: Schema.String,
  cube: Schema.String,
  entityType: Schema.String,
  entityId: Schema.String,
  action: Schema.String,
  result: Schema.Literal("allowed", "denied", "success"),
  before: Schema.Unknown,
  after: Schema.Unknown,
}).annotations({ identifier: "PermissionAuditEvent" })
export const AuditEventPageSchema = Schema.Struct({
  rows: Schema.Array(AuditEventSchema),
  total: Schema.Number,
  offset: Schema.Number,
  limit: Schema.Number,
  sortedBy: Schema.String,
}).annotations({ identifier: "PermissionAuditPage" })
export const VisibilityViewSchema = Schema.Literal(
  "all",
  "owned-by-me",
  "created-by-me",
  "only-mine",
  "shared-by-me",
  "shared-with-me",
  "hidden-by-me",
)
export const VisibilityListParams = Schema.Struct({
  view: Schema.optionalWith(VisibilityViewSchema, { default: () => "all" as const }),
  offset: Schema.optionalWith(Schema.NumberFromString, { default: () => 0 }),
  limit: Schema.optionalWith(Schema.NumberFromString, { default: () => 10 }),
})
export const EntityVisibilitySchema = Schema.Struct({
  cube: Schema.String,
  entityType: Schema.String,
  entityId: Schema.String,
  ownerId: Schema.String,
  createdBy: Schema.String,
  access: Schema.Struct({
    source: Schema.Literal("owner", "creator", "user-grant", "group-grant", "cube-admin", "superadmin"),
    name: Schema.String,
    actions: Schema.Array(GrantAction),
  }),
  hidden: Schema.Boolean,
  sharedWithCount: Schema.Number,
}).annotations({ identifier: "EntityVisibility" })
export const EntityVisibilityPageSchema = Schema.Struct({
  rows: Schema.Array(EntityVisibilitySchema),
  total: Schema.Number,
  offset: Schema.Number,
  limit: Schema.Number,
  sortedBy: Schema.String,
}).annotations({ identifier: "EntityVisibilityPage" })
export const VisibilityMutationSchema = Schema.Struct({ hidden: Schema.Boolean }).annotations({
  identifier: "VisibilityMutation",
})
