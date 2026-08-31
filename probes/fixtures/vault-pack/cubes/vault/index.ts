// The VAULT fixture cube -- the QWB-54 ticket 05 evidence target.
//
// Modeled on the guestbook fixture (one declared field, entity routes, no entity permissions),
// with one deliberate difference: the ROLES ARE SKEWED. `vault:read` is granted to a role no
// account can hold ("curator"), `vault:write` to "admin". That combination is the whole point:
// an admin token carries customfields:write but NOT vault:read, and a reader token carries
// customfields:read but NOT vault:read -- exactly the two shapes ticket 05's new permission
// gates are supposed to refuse with 403 while still letting the admin write rows.

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization, requirePermission } from "qwbe-core/auth"
import { type CubeTools, defineCube } from "qwbe-core/cube"
import { EntityMeta, type SummaryRow } from "qwbe-core/entity"
import { Forbidden, NotFound } from "qwbe-core/errors"
import { PageOf } from "qwbe-core/http"
import { PageParams, pageRequest } from "qwbe-core/pagination"

const TABLE = "vault_items"
const ENTITY = "VaultItem"

const Item = Schema.Struct({
  ...EntityMeta,
  name: Schema.String,
}).annotations({ identifier: "VaultItem" })

const ItemCreate = Schema.Struct({ name: Schema.String }).annotations({ identifier: "VaultItemCreate" })

type ItemRow = typeof Item.Type

const group = HttpApiGroup.make("vault")
  .add(HttpApiEndpoint.get("list")`/vault`.setUrlParams(PageParams).addSuccess(PageOf(Item)).addError(Forbidden))
  .add(
    HttpApiEndpoint.get("get")`/vault/${HttpApiSchema.param("id", Schema.String)}`
      .addSuccess(Item)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.patch("patch")`/vault/${HttpApiSchema.param("id", Schema.String)}`
      .setPayload(Schema.partial(ItemCreate))
      .addSuccess(Item)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .add(HttpApiEndpoint.post("create")`/vault`.setPayload(ItemCreate).addSuccess(Item).addError(Forbidden))
  .middleware(Authorization)

const summary = (e: ItemRow): SummaryRow => ({ id: e.id, title: e.name, details: [] })

export const cube = defineCube(group, {
  manifest: {
    name: "vault",
    tables: [TABLE],
    entity: ENTITY,
    sortable: ["name", "createdAt"],
    requiresAuth: true,
    permissions: [
      // The skew: nobody holds "curator", so NO token has vault:read -- while admin keeps
      // vault:write and can create the rows the evidence needs.
      { name: "vault:read", roles: ["curator"] },
      { name: "vault:write", roles: ["admin"] },
    ],
  },

  create: ({ store }: CubeTools) => ({
    handlers: {
      list: ({ urlParams }: { urlParams: typeof PageParams.Type }) =>
        Effect.gen(function* () {
          yield* requirePermission("vault:read")
          const page = yield* store.page<ItemRow>(TABLE, pageRequest(urlParams))
          return {
            rows: page.rows,
            total: page.total,
            offset: page.offset,
            limit: page.limit,
            sortedBy: page.sortedBy,
          }
        }),

      get: ({ path }: { path: { readonly id: string } }) =>
        Effect.gen(function* () {
          yield* requirePermission("vault:read")
          const row = yield* store.byId<ItemRow>(TABLE, path.id)
          if (!row) return yield* Effect.fail(new NotFound({ message: `no vault item ${path.id}` }))
          return row
        }),

      patch: ({ path, payload }: { path: { readonly id: string }; payload: Record<string, unknown> }) =>
        Effect.gen(function* () {
          yield* requirePermission("vault:write")
          const row = yield* store.update(TABLE, path.id, payload)
          if (!row) return yield* Effect.fail(new NotFound({ message: `no vault item ${path.id}` }))
          return row as ItemRow
        }),

      create: ({ payload }: { payload: typeof ItemCreate.Type }) =>
        Effect.gen(function* () {
          yield* requirePermission("vault:write")
          const custom = (payload as { custom?: Record<string, unknown> }).custom
          return (yield* store.insert(TABLE, ENTITY, "vb", { name: payload.name, custom })) as ItemRow
        }),
    },

    relational: {
      search: (field, value, page) =>
        Effect.gen(function* () {
          const p = yield* store.page<ItemRow>(TABLE, page, { field, value })
          return { rows: p.rows.map(summary), total: p.total }
        }),
      summaryById: (id) =>
        Effect.gen(function* () {
          const row = yield* store.byId<ItemRow>(TABLE, id)
          return row ? summary(row) : undefined
        }),
    },
  }),
})
