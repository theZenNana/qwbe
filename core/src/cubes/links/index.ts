// The LINKS cube — the only one that talks to the registry, and itself an ordinary cube:
// remove its directory and the system starts without it, just with no related lists. Nothing
// in the kernel knows it by name.
//
// TWO STEPS, and this is a contract decision rather than an optimisation.
//
// The previous iteration walked the reverse direction with two sequential calls per link field
// and returned EVERY row of EVERY group just to render ten. An account with 400 notes cost 400
// summaries before the page could draw.
//
//     GET /links/{entity}/{id}           → which groups exist, and HOW MANY rows each has
//     GET /links/{entity}/{id}/{cube}    → the rows of ONE group, paged
//
// The page asks for the cheap group heads first (limit 1, only `total` matters), then the rows
// of the group a person actually opens. An account with 400 notes and 3000 other rows now costs
// two numbers, not 3400 summaries.

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Schema } from "effect"
import { defineCube } from "qwbe-core/cube"
import { LinksFor } from "../../http-contracts.ts"
import { Authorization, CurrentUser, requirePermission } from "../../kernel/auth-contract.ts"
import { Summary } from "../../kernel/entity.ts"
import { Forbidden, NotFound } from "../../kernel/errors.ts"
import { PageOf, PageParams, pageRequest } from "../../kernel/pagination.ts"
import { Registry } from "../../kernel/registry.ts"

const group = HttpApiGroup.make("links")
  .add(
    HttpApiEndpoint.get(
      "for",
    )`/links/${HttpApiSchema.param("entity", Schema.String)}/${HttpApiSchema.param("id", Schema.String)}`
      .addSuccess(LinksFor)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.get(
      "group",
    )`/links/${HttpApiSchema.param("entity", Schema.String)}/${HttpApiSchema.param("id", Schema.String)}/${HttpApiSchema.param("cube", Schema.String)}`
      .setUrlParams(PageParams)
      .addSuccess(PageOf(Summary))
      .addError(NotFound)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.get("entities")`/links`
      .addSuccess(Schema.Array(Schema.Struct({ cube: Schema.String, entity: Schema.String })))
      .addError(Forbidden),
  )
  .middleware(Authorization)

// Route permissions, published by the metadata and checked by the handlers (see metadata/declarations.ts).
const ROUTES = {
  entities: "links:read",
  for: "links:read",
  group: "links:read",
} as const

/** We do not want the rows, only `total`. Limit 1 because 0 is meaningless and would be capped. */
const COUNT_ONLY = pageRequest({ offset: 0, limit: 1 })

export const cube = defineCube(group, {
  manifest: {
    name: "links",
    // Owns no data at all. This cube lives entirely off the registry, so its store can open
    // nothing — which is exactly right.
    tables: [],
    requiresAuth: true,
    permissions: [{ name: "links:read", roles: ["admin", "reader"] }],
    routes: ROUTES,
  },

  create: () => ({
    handlers: {
      entities: () =>
        Effect.gen(function* () {
          yield* requirePermission(ROUTES.entities)
          const registry = yield* Registry
          return registry.entities()
        }),

      for: ({ path }: { path: { entity: string; id: string } }) =>
        Effect.gen(function* () {
          yield* requirePermission(ROUTES.for)
          const registry = yield* Registry
          const user = yield* CurrentUser

          const owner = registry.entities().find((e) => e.entity === path.entity)
          if (!owner) {
            return yield* Effect.fail(new NotFound({ message: `no active cube holds entity ${path.entity}` }))
          }

          // Forward: what this row holds in its link fields. The value comes from the owning
          // cube, the summary from the target cube — no join anywhere.
          const parents = yield* Effect.forEach(registry.linksFrom(owner.cube), (l) =>
            Effect.gen(function* () {
              const v = yield* registry.fieldValue(owner.cube, path.id, l.field, user)
              const s = v ? yield* registry.summary(l.to, v, user) : undefined
              return { field: l.field, to: l.to, summary: s ?? null }
            }),
          )

          // Reverse: group heads only, with totals. This is where the N+1 used to be.
          const groups = yield* Effect.forEach(registry.linksTo(path.entity), (g) =>
            Effect.gen(function* () {
              const r = yield* registry.search(g.cube, g.field, path.id, COUNT_ONLY)
              return { cube: g.cube, label: g.label, field: g.field, total: r.total }
            }),
          )

          return { entity: path.entity, id: path.id, parents, groups }
        }),

      group: ({
        path,
        urlParams,
      }: {
        path: { entity: string; id: string; cube: string }
        urlParams: typeof PageParams.Type
      }) =>
        Effect.gen(function* () {
          yield* requirePermission(ROUTES.group)
          const registry = yield* Registry

          const g = registry.linksTo(path.entity).find((x) => x.cube === path.cube)
          if (!g) {
            return yield* Effect.fail(
              new NotFound({
                message: `no space declares a link from ${path.cube} to ${path.entity}, or a side is switched off`,
              }),
            )
          }

          const r = yield* registry.search(g.cube, g.field, path.id, pageRequest(urlParams))
          // The owning cube decides the ordering of its own group and the registry does not
          // carry that back, so this reports the default rather than inventing a field name.
          return {
            rows: r.rows,
            total: r.total,
            offset: urlParams.offset,
            limit: urlParams.limit,
            sortedBy: "createdAt",
          }
        }),
    },
  }),
})
