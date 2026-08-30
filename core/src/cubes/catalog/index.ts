// The CATALOG cube -- per-cube field metadata, so a frontend can build lists, forms and detail
// views from what the API publishes instead of hand-written shapes.
//
// The metadata is DERIVED, not declared here: `buildCatalogue` derives it from each cube's own
// Effect schema and manifest (see `src/metadata/metadata.ts`), and this cube only PUBLISHES it.
// There is no field list in this file to drift from the schemas it describes.
//
// Permission model: the metadata of a cube is readable exactly as far as the cube itself is.
// There is no `catalog:read` -- the check is the target cube's own read permission, computed
// per request. A caller without it gets 403 and learns no shape; an unknown or disabled cube
// gets 404, like every disabled cube's routes.

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Schema } from "effect"
import { type CubeTools, defineCube } from "qwbe-core/cube"
import { Authorization, requirePermission } from "../../kernel/auth-contract.ts"
import { Forbidden, NotFound } from "../../kernel/errors.ts"
import { CubeMetadata } from "../../metadata/metadata.ts"

/** The read permission of a cube is its full name plus `:read` -- the convention every cube follows. */
export const readPermissionOf = (cube: string): string => `${cube}:read`

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
          // Order matters: unknown or disabled first (404, matching the disabled-cube rule that
          // runs in front of authentication), THEN the target cube's own read permission.
          const entry = catalogue().find((c) => c.name === path.cube)
          if (!entry?.enabled) {
            return yield* Effect.fail(new NotFound({ message: `cube ${path.cube} is not mounted` }))
          }
          yield* requirePermission(readPermissionOf(path.cube))
          if (!entry.metadata) {
            return yield* Effect.fail(new NotFound({ message: `cube ${path.cube} publishes no field metadata` }))
          }
          return entry.metadata
        }),
    },
  }),
})
