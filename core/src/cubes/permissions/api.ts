import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Schema } from "effect"
import { Authorization } from "qwbe-core/auth"
import { Forbidden } from "qwbe-core/errors"
import {
  AuditEventPageSchema,
  AuditQuerySchema,
  CubeAdminAssign,
  CubeAdminSchema,
  EntityGrantSchema,
  EntityVisibilityPageSchema,
  EntityVisibilitySchema,
  GroupCreate,
  GroupGrantCreate,
  GroupListParams,
  GroupMembershipSchema,
  GroupRename,
  MemberRemove,
  MembershipCreate,
  OwnershipSchema,
  OwnershipTransfer,
  PermissionGroupSchema,
  UserGrantCreate,
  VisibilityListParams,
  VisibilityMutationSchema,
} from "qwbe-core/permissions"

export const group = HttpApiGroup.make("permissions")
  .add(
    HttpApiEndpoint.post("createPermissionGroup")`/permissions/groups`
      .setPayload(GroupCreate)
      .addSuccess(PermissionGroupSchema)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.get("permissionCubeAdmins")`/permissions/cube-admins`
      .setUrlParams(GroupListParams)
      .addSuccess(Schema.Array(CubeAdminSchema))
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.post("assignPermissionCubeAdmin")`/permissions/cube-admins`
      .setPayload(CubeAdminAssign)
      .addSuccess(Schema.Struct({ assigned: Schema.String }))
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.post(
      "transferPermissionOwnership",
    )`/permissions/entities/${HttpApiSchema.param("cube", Schema.String)}/${HttpApiSchema.param("entityType", Schema.String)}/${HttpApiSchema.param("entityId", Schema.String)}/owner`
      .setPayload(OwnershipTransfer)
      .addSuccess(OwnershipSchema)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.get("permissionGroups")`/permissions/groups`
      .setUrlParams(GroupListParams)
      .addSuccess(Schema.Array(PermissionGroupSchema))
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.patch("renamePermissionGroup")`/permissions/groups/${HttpApiSchema.param("groupId", Schema.String)}`
      .setPayload(GroupRename)
      .addSuccess(PermissionGroupSchema)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.post(
      "addPermissionGroupMember",
    )`/permissions/groups/${HttpApiSchema.param("groupId", Schema.String)}/members`
      .setPayload(MembershipCreate)
      .addSuccess(GroupMembershipSchema)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.post(
      "removePermissionGroupMember",
    )`/permissions/groups/${HttpApiSchema.param("groupId", Schema.String)}/members/remove`
      .setPayload(MemberRemove)
      .addSuccess(Schema.Struct({ removed: Schema.String }))
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.post(
      "grantPermissionUser",
    )`/permissions/entities/${HttpApiSchema.param("cube", Schema.String)}/${HttpApiSchema.param("entityType", Schema.String)}/${HttpApiSchema.param("entityId", Schema.String)}/grants/user`
      .setPayload(UserGrantCreate)
      .addSuccess(EntityGrantSchema)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.post(
      "grantPermissionGroup",
    )`/permissions/entities/${HttpApiSchema.param("cube", Schema.String)}/${HttpApiSchema.param("entityType", Schema.String)}/${HttpApiSchema.param("entityId", Schema.String)}/grants/group`
      .setPayload(GroupGrantCreate)
      .addSuccess(EntityGrantSchema)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.del("revokePermissionGrant")`/permissions/grants/${HttpApiSchema.param("grantId", Schema.String)}`
      .addSuccess(Schema.Struct({ revoked: Schema.String }))
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.get("permissionAudit")`/permissions/audit`
      .setUrlParams(AuditQuerySchema)
      .addSuccess(AuditEventPageSchema)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.get("visibleEntities")`/permissions/entities/${HttpApiSchema.param("cube", Schema.String)}`
      .setUrlParams(VisibilityListParams)
      .addSuccess(EntityVisibilityPageSchema)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.post(
      "setEntityVisibility",
    )`/permissions/entities/${HttpApiSchema.param("cube", Schema.String)}/${HttpApiSchema.param("entityType", Schema.String)}/${HttpApiSchema.param("entityId", Schema.String)}/visibility`
      .setPayload(VisibilityMutationSchema)
      .addSuccess(EntityVisibilitySchema)
      .addError(Forbidden),
  )
  .middleware(Authorization)
