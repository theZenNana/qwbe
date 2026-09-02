import { type CubeTools, defineCube } from "qwbe-core/cube"
import { group } from "./api.ts"
import { foundationHandlers } from "./foundation-handlers.ts"
import { serviceFrom } from "./service.ts"
import { sharingHandlers } from "./sharing-handlers.ts"
import { tables } from "./state.ts"
import { visibilityHandlers } from "./visibility-handlers.ts"

// Route permissions, published by the metadata and checked by the handlers (see metadata/declarations.ts).
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
