import { Effect } from "effect"
import { CurrentUser } from "qwbe-core/auth"
import type {
  EntityRef,
  PermissionService,
  VisibilityListParams,
  VisibilityMutationSchema,
} from "qwbe-core/permissions"
import { pageRequest } from "../../kernel/pagination.ts"
import { actorFrom, forbidden } from "./handler-utils.ts"

export const visibilityHandlers = (service: PermissionService) => ({
  visibleEntities: ({ path, urlParams }: { path: { cube: string }; urlParams: typeof VisibilityListParams.Type }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const requested = pageRequest(urlParams)
      const rows = yield* service.listVisible(actorFrom(user), path.cube, urlParams.view)
      return {
        rows: rows.slice(requested.offset, requested.offset + requested.limit),
        total: rows.length,
        offset: requested.offset,
        limit: requested.limit,
        sortedBy: "createdAt",
      }
    }),
  setEntityVisibility: ({ path, payload }: { path: EntityRef; payload: typeof VisibilityMutationSchema.Type }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      return yield* service
        .setHidden(actorFrom(user), path, payload.hidden)
        .pipe(Effect.mapError(forbidden("permissions:visibility")))
    }),
})
