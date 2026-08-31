// The CATALOG cube -- per-cube field metadata, so a frontend can build lists, forms and detail
// views from what the API publishes instead of hand-written shapes.
//
// The metadata is DERIVED, not declared here: `buildCatalogue` derives it from each cube's own
// Effect schema and manifest (see `src/metadata/metadata.ts`), and this cube only PUBLISHES it.
// There is no field list in this file to drift from the schemas it describes.
//
// Permission model: the metadata of a cube is readable exactly as far as the cube itself is.
// There is no `catalog:read` -- the check is the target cube's own read permission, computed
// per request. A caller without it gets 404, same as an unknown or disabled cube: a 403 would
// let any authenticated caller enumerate which cubes exist.

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Schema } from "effect"
import { type CubeTools, defineCube } from "qwbe-core/cube"
import { Authorization, readPermissionOf, requirePermission } from "../../kernel/auth-contract.ts"
import { Forbidden, NotFound } from "../../kernel/errors.ts"
import { CubeMetadata } from "../../metadata/metadata.ts"

/**
 * The read permission of a cube is its full name plus `:read`. The rule lives in the kernel
 * (`kernel/auth-contract.ts`) next to the permission contract it belongs to, because the
 * kernel itself derives the same name for the generic list route and for the published
 * metadata; re-exported here so the cube's own callers keep one import site.
 */
export { readPermissionOf }

const group = HttpApiGroup.make("catalog")
  .add(
    HttpApiEndpoint.get("metadata")`/catalog/${HttpApiSchema.param("cube", Schema.String)}/metadata`
      .addSuccess(CubeMetadata)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .middleware(Authorization)

export const cube = defineCube(group, {
  manifest: {
    name: "catalog",
    tables: [],
    requiresAuth: true,
  },

  create: ({ catalogue }: CubeTools) => ({
    handlers: {
      metadata: ({ path }: { path: { cube: string } }) =>
        Effect.gen(function* () {
          // "No permission" answers 404, exactly like an unknown or disabled cube: answering
          // 403 would let any authenticated caller tell "exists but forbidden" from "does not
          // exist" and enumerate the mounted cubes. The cost is that a caller who may not
          // read the cube cannot tell WHY -- the metadata teaches nothing either way.
          const entry = catalogue().find((c) => c.name === path.cube)
          yield* requirePermission(readPermissionOf(path.cube)).pipe(
            Effect.catchTag("Forbidden", () =>
              Effect.fail(new NotFound({ message: `cube ${path.cube} is not mounted` })),
            ),
          )
          if (!entry?.enabled) {
            return yield* Effect.fail(new NotFound({ message: `cube ${path.cube} is not mounted` }))
          }
          if (!entry.metadata) {
            return yield* Effect.fail(new NotFound({ message: `cube ${path.cube} publishes no field metadata` }))
          }
          return entry.metadata
        }),
    },
  }),
})
