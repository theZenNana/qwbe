import type { CubeTools } from "qwbe-core/cube"
import type { PermissionService } from "qwbe-core/permissions"
import { foundationFrom } from "./foundation.ts"
import { groupsFrom } from "./groups.ts"
import { sharingFrom } from "./sharing.ts"
import { stateFrom } from "./state.ts"
import { visibilityFrom } from "./visibility.ts"

export const serviceFrom = (store: CubeTools["store"]): PermissionService => {
  const state = stateFrom(store)
  const foundation = foundationFrom(state)
  const { decide: _decide, requireShare: _requireShare, ...publicFoundation } = foundation
  return {
    ...publicFoundation,
    ...groupsFrom(state),
    ...sharingFrom(state, foundation),
    ...visibilityFrom(state),
  }
}
