import { Effect } from "effect"
import { CurrentUser } from "qwbe-core/auth"
import { pageRequest } from "qwbe-core/pagination"
import type {
  EntityRef,
  PermissionService,
  VisibilityListParams,
  VisibilityMutationSchema,
} from "qwbe-core/permissions"
import { actorFrom, mapPermissionError } from "./handler-utils.ts"

const visibilityError = mapPermissionError("permissions:visibility")

export const visibilityHandlers = (service: PermissionService) => ({
  visibleEntities: ({ path, urlParams }: { path: { cube: string }; urlParams: typeof VisibilityListParams.Type }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      return yield* service.listVisible(actorFrom(user), path.cube, urlParams.view, pageRequest(urlParams))
    }),
  setEntityVisibility: ({ path, payload }: { path: EntityRef; payload: typeof VisibilityMutationSchema.Type }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      return yield* service.setHidden(actorFrom(user), path, payload.hidden).pipe(visibilityError)
    }),
})
