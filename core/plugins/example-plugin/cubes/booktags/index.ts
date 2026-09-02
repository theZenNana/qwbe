// BOOKTAGS -- the canonical runtime-hierarchy example (docs/booktags-hierarchy.md).
//
// A parent cube. It owns no tables and no entity: it is a namespace root, a lifecycle unit,
// and one entry in the sidebar. Its children live in subdirectories of this one and are
// addressed as `booktags/bookmarks`, `booktags/tags`, `booktags/settings`.
//
// Nothing here names the children. The directory layout does, and each child's manifest
// names this cube as its `parent` -- checked at mount against the real layout, so neither
// side can lie. Removing Booktags is deleting this directory; the children go with it and
// no file anywhere else is edited.

import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization, requirePermission } from "qwbe-core/auth"
import { type CubeTools, defineCube } from "qwbe-core/cube"
import { Forbidden } from "qwbe-core/errors"

const ChildInfo = Schema.Struct({
  name: Schema.String,
  entity: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
}).annotations({ identifier: "BooktagsChild" })

const group = HttpApiGroup.make("booktags")
  .add(HttpApiEndpoint.get("children")`/booktags`.addSuccess(Schema.Array(ChildInfo)).addError(Forbidden))
  .middleware(Authorization)

export const cube = defineCube(group, {
  manifest: {
    name: "booktags",
    tables: [],
    // The screen is the point of a parent: one Booktags entry in the sidebar, with the
    // children as its surfaces. It holds no entity, exactly like `settings` in core.
    screen: true,
    requiresAuth: true,
    permissions: [{ name: "booktags:read", roles: ["admin", "reader"] }],
    // Declared route: the mount wrapper enforces before the handler runs -- the same
    // permission the children handler below requires.
    routes: { children: "booktags:read" },
    // The flat cubes this hierarchy replaced: their data files move to the children's files.
    // Declared in the manifest -- never executed by the cube -- and the kernel checks every
    // entry against the mounted set and this package's provenance before touching a byte.
    dataMigration: [
      { fromCube: "bookmarks", toCube: "booktags/bookmarks", fromPlugin: "example-plugin" },
      { fromCube: "tags", toCube: "booktags/tags", fromPlugin: "example-plugin" },
    ],
  },

  create: ({ catalogue }: CubeTools) => ({
    commands: [
      {
        name: "booktags:children",
        summary: "the mounted children of this hierarchy",
        permission: "booktags:read",
        run: () =>
          Effect.succeed(
            catalogue()
              .filter((c) => c.parent === "booktags")
              .map((c) => `${c.name} (${c.enabled ? "on" : "off"})`)
              .join("\n") || "(none)",
          ),
      },
    ],

    handlers: {
      children: () =>
        Effect.gen(function* () {
          yield* requirePermission("booktags:read")
          return catalogue()
            .filter((c) => c.parent === "booktags")
            .map((c) => ({ name: c.name, entity: c.entity ?? null, enabled: c.enabled }))
        }),
    },
  }),
})
