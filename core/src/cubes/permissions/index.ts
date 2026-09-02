import { type CubeTools, defineCube } from "qwbe-core/cube"
import { group } from "./api.ts"
import { foundationHandlers } from "./foundation-handlers.ts"
import { serviceFrom } from "./service.ts"
import { sharingHandlers } from "./sharing-handlers.ts"
import { tables } from "./state.ts"
import { visibilityHandlers } from "./visibility-handlers.ts"

/**
 * The permission each MUTATING route requires, declared once (QWB-54, 14c): the mount wrapper
 * enforces exactly this before the handler runs. Every sharing/visibility endpoint authorizes
 * per request through the entity permission service -- the actor's grants on THAT entity -- so
 * its entry is an explicit `null`; a fixed name would be a lie. `permissionAudit` is the one
 * endpoint whose handler checks a fixed permission inline. The read endpoints authorize the
 * same way -- they list what the actor may see -- so they are nulls too (QWB-54, 14c).
 */
const ROUTES = {
  permissionAudit: "permissions:read",
  createPermissionGroup: null,
  assignPermissionCubeAdmin: null,
  revokePermissionCubeAdmin: null,
  transferPermissionOwnership: null,
  renamePermissionGroup: null,
  addPermissionGroupMember: null,
  removePermissionGroupMember: null,
  grantPermissionUser: null,
  grantPermissionGroup: null,
  revokePermissionGrant: null,
  setEntityVisibility: null,
  permissionEntityGrants: null,
  permissionCubeAdmins: null,
  permissionGroups: null,
  visibleEntities: null,
} as const

export const cube = defineCube(group, {
  manifest: {
    name: "permissions",
    tables: Object.values(tables),
    screen: true,
    requiresAuth: true,
    required: true,
    providesEntityPermissions: true,
    usesIdentityDirectory: true,
    permissions: [
      { name: "permissions:read", roles: ["admin"] },
      { name: "permissions:write", roles: ["admin"] },
    ],
    routes: ROUTES,
  },
  create: ({ store, identities }: CubeTools) => {
    const entityPermissions = serviceFrom(store)
    return {
      handlers: {
        ...foundationHandlers(entityPermissions, identities),
        ...sharingHandlers(entityPermissions, identities),
        ...visibilityHandlers(entityPermissions),
      },
      entityPermissions,
    }
  },
})
