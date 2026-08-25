import { Schema } from "effect"
import type { GrantAction } from "qwbe-core/permissions"
import { request } from "./api.ts"
import {
  AuditEventPageSchema,
  CubeAdminSchema,
  type EntityGrant,
  EntityGrantSchema,
  type EntityVisibility,
  EntityVisibilityPageSchema,
  EntityVisibilitySchema,
  PagedSchema,
  PermissionGroupSchema,
  type VisibilityView,
} from "./contracts.ts"
import { grantsListPath, permissionsListPath, revokeGrantPath, visibilityMutationPath } from "./permissions-ui.ts"

export const visibleEntities = (cube: string, view: VisibilityView, offset = 0, limit = 10) =>
  request(permissionsListPath(cube, { view, offset, limit }), EntityVisibilityPageSchema)

export const setEntityHidden = (value: EntityVisibility, hidden: boolean) =>
  request(visibilityMutationPath(value), EntityVisibilitySchema, {
    method: "POST",
    body: JSON.stringify({ hidden }),
  })

const entityPath = (value: EntityVisibility) =>
  `/permissions/entities/${encodeURIComponent(value.cube)}/${encodeURIComponent(value.entityType)}/${encodeURIComponent(value.entityId)}`

export const shareEntityWithUser = (value: EntityVisibility, username: string, actions?: ReadonlyArray<GrantAction>) =>
  request(`${entityPath(value)}/grants/user`, EntityGrantSchema, {
    method: "POST",
    body: JSON.stringify({ username, ...(actions ? { actions } : {}) }),
  })

export const permissionGroups = (cube: string) =>
  request(`/permissions/groups?cube=${encodeURIComponent(cube)}`, Schema.Array(PermissionGroupSchema))

export const createPermissionGroup = (cube: string, name: string) =>
  request("/permissions/groups", PermissionGroupSchema, {
    method: "POST",
    body: JSON.stringify({ cube, name }),
  })

export const addPermissionGroupMember = (groupId: string, username: string) =>
  request(`/permissions/groups/${encodeURIComponent(groupId)}/members`, Schema.Unknown, {
    method: "POST",
    body: JSON.stringify({ username }),
  })

export const shareEntityWithGroup = (value: EntityVisibility, groupId: string, actions: ReadonlyArray<GrantAction>) =>
  request(`${entityPath(value)}/grants/group`, EntityGrantSchema, {
    method: "POST",
    body: JSON.stringify({ groupId, actions }),
  })

export const entityGrants = (value: EntityVisibility, offset = 0, limit = 20) =>
  request(grantsListPath(value, offset, limit), PagedSchema(EntityGrantSchema))

export const revokeEntityGrant = (grant: Pick<EntityGrant, "id">) =>
  request(revokeGrantPath(grant.id), Schema.Struct({ revoked: Schema.String }), { method: "DELETE" })

export const permissionCubeAdmins = (cube: string) =>
  request(`/permissions/cube-admins?cube=${encodeURIComponent(cube)}`, Schema.Array(CubeAdminSchema))

export const assignPermissionCubeAdmin = (cube: string, username: string) =>
  request("/permissions/cube-admins", Schema.Struct({ assigned: Schema.String }), {
    method: "POST",
    body: JSON.stringify({ cube, username }),
  })

export const permissionAudit = (offset = 0, limit = 50) =>
  request(`/permissions/audit?offset=${offset}&limit=${limit}`, AuditEventPageSchema)
