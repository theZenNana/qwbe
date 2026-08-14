import { Schema } from "effect"
import { request } from "./api.ts"
import {
  AuditEventPageSchema,
  CubeAdminSchema,
  EntityGrantSchema,
  type EntityVisibility,
  EntityVisibilityPageSchema,
  EntityVisibilitySchema,
  PermissionGroupSchema,
  type VisibilityView,
} from "./contracts.ts"
import { permissionsListPath, visibilityMutationPath } from "./permissions-ui.ts"

export const visibleEntities = (cube: string, view: VisibilityView, offset = 0, limit = 10) =>
  request(permissionsListPath(cube, { view, offset, limit }), EntityVisibilityPageSchema)

export const setEntityHidden = (value: EntityVisibility, hidden: boolean) =>
  request(visibilityMutationPath(value), EntityVisibilitySchema, {
    method: "POST",
    body: JSON.stringify({ hidden }),
  })

const entityPath = (value: EntityVisibility) =>
  `/permissions/entities/${encodeURIComponent(value.cube)}/${encodeURIComponent(value.entityType)}/${encodeURIComponent(value.entityId)}`

export const shareEntityWithUser = (value: EntityVisibility, username: string, actions?: ReadonlyArray<string>) =>
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

export const shareEntityWithGroup = (value: EntityVisibility, groupId: string, actions: ReadonlyArray<string>) =>
  request(`${entityPath(value)}/grants/group`, EntityGrantSchema, {
    method: "POST",
    body: JSON.stringify({ groupId, actions }),
  })

export const permissionCubeAdmins = (cube: string) =>
  request(`/permissions/cube-admins?cube=${encodeURIComponent(cube)}`, Schema.Array(CubeAdminSchema))

export const assignPermissionCubeAdmin = (cube: string, username: string) =>
  request("/permissions/cube-admins", Schema.Struct({ assigned: Schema.String }), {
    method: "POST",
    body: JSON.stringify({ cube, username }),
  })

export const permissionAudit = (offset = 0, limit = 50) =>
  request(`/permissions/audit?offset=${offset}&limit=${limit}`, AuditEventPageSchema)
