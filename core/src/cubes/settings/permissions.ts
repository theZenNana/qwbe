import { Effect } from "effect"
import { CurrentUser } from "qwbe-core/auth"
import type { PermissionService } from "qwbe-core/permissions"

export const assignCurrentUserCubeAdmin = (service: PermissionService, cubes: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const user = yield* CurrentUser
    yield* Effect.forEach(cubes, (cube) =>
      service.assignCubeAdmin({ userId: user.id, roles: user.roles }, cube, user.id),
    )
  })
