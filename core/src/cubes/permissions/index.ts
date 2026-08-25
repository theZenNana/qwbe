import { type CubeTools, defineCube } from "qwbe-core/cube"
import { group } from "./api.ts"
import { foundationHandlers } from "./foundation-handlers.ts"
import { serviceFrom } from "./service.ts"
import { sharingHandlers } from "./sharing-handlers.ts"
import { tables } from "./state.ts"
import { visibilityHandlers } from "./visibility-handlers.ts"

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
