// The CONTRACTS cube — the other half of the same plugin.
//
// It carries `partyId`, an id and nothing else. No import, no name of the cube that holds the
// other end, no copy of a field from it: if the party's cube is switched off or removed, this
// one keeps starting and keeps serving, with an id that resolves to nothing. That is the same
// bargain every other cube in the system makes, and the reason a plugin can be uninstalled a
// piece at a time.
//
// Whoever wants the two shown side by side declares that in a space, one level up — a third
// party, so neither cube learns about the other.

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization, requirePermission } from "../../../../src/kernel/auth-contract.ts"
import { EntityMeta, type SummaryRow } from "../../../../src/kernel/entity.ts"
import { Forbidden, NotFound } from "../../../../src/kernel/errors.ts"
import type { CubeDefinition, CubeTools } from "../../../../src/kernel/manifest.ts"
import { PageOf, PageParams, pageRequest } from "../../../../src/kernel/pagination.ts"

const TABLE = "contracts"
const ENTITY = "Contract"

const Contract = Schema.Struct({
  ...EntityMeta,
  title: Schema.String,
  /** Minor units (bani, cents). Stored as an integer so no rounding happens on the way in. */
  amount: Schema.Number,
  currency: Schema.String,
  signedAt: Schema.NullOr(Schema.String),
  /** The other side of the deal. Just an id — nothing copied from the cube that holds it. */
  partyId: Schema.NullOr(Schema.String),
}).annotations({ identifier: "Contract" })

const ContractCreate = Schema.Struct({
  title: Schema.String,
  amount: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  currency: Schema.optionalWith(Schema.String, { default: () => "RON" }),
  signedAt: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  partyId: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
}).annotations({ identifier: "ContractCreate" })

type ContractRow = typeof Contract.Type

const group = HttpApiGroup.make("contracts")
  .add(
    HttpApiEndpoint.get("list")`/contracts`.setUrlParams(PageParams).addSuccess(PageOf(Contract)).addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.get("get")`/contracts/${HttpApiSchema.param("id", Schema.String)}`
      .addSuccess(Contract)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .add(HttpApiEndpoint.post("create")`/contracts`.setPayload(ContractCreate).addSuccess(Contract).addError(Forbidden))
  .middleware(Authorization)

const money = (c: ContractRow): string => `${(c.amount / 100).toFixed(2)} ${c.currency}`

const summary = (c: ContractRow): SummaryRow => ({
  id: c.id,
  title: c.title,
  details: [
    { key: "amount", value: money(c) },
    { key: "signed", value: c.signedAt ?? "unsigned" },
  ],
})

export const cube: CubeDefinition = {
  manifest: {
    name: "contracts",
    tables: [TABLE],
    entity: ENTITY,
    sortable: ["title", "amount", "signedAt", "createdAt"],
    requiresAuth: true,
    permissions: [
      { name: "contracts:read", roles: ["admin", "reader"] },
      { name: "contracts:write", roles: ["admin"] },
    ],
    publishes: ["contracts.created"],
  },

  create: ({ store, bus }: CubeTools) => ({
    group,

    commands: [
      {
        name: "contracts:count",
        summary: "how many contracts exist",
        permission: "contracts:read",
        run: () => Effect.map(store.count(TABLE), (n) => String(n)),
      },
      {
        name: "contracts:value",
        summary: "total value of the newest contracts — `contracts:value [howMany]`",
        permission: "contracts:read",
        maxArgs: 1,
        run: (args) =>
          Effect.gen(function* () {
            // A page, not the whole table: the same cap the HTTP list is subject to. A command
            // that quietly reads everything would be the back door around contract pagination.
            const howMany = Math.min(50, Math.max(1, Number(args[0] ?? 10) || 10))
            const p = yield* store.page<ContractRow>(TABLE, {
              offset: 0,
              limit: howMany,
              sortBy: "createdAt",
              descending: true,
            })
            if (p.rows.length === 0) return "(none)"
            // Currencies are not summed together — adding RON to EUR produces a number that
            // looks authoritative and means nothing.
            const perCurrency = new Map<string, number>()
            for (const c of p.rows) perCurrency.set(c.currency, (perCurrency.get(c.currency) ?? 0) + c.amount)
            return [...perCurrency].map(([currency, total]) => `${(total / 100).toFixed(2)} ${currency}`).join("\n")
          }),
      },
    ],

    handlers: {
      list: ({ urlParams }: { urlParams: typeof PageParams.Type }) =>
        Effect.gen(function* () {
          yield* requirePermission("contracts:read")
          return yield* store.page<ContractRow>(TABLE, pageRequest(urlParams))
        }),

      get: ({ path }: { path: { id: string } }) =>
        Effect.gen(function* () {
          yield* requirePermission("contracts:read")
          const c = yield* store.byId<ContractRow>(TABLE, path.id)
          if (!c) return yield* Effect.fail(new NotFound({ message: `contract ${path.id} does not exist` }))
          return c
        }),

      create: ({ payload }: { payload: typeof ContractCreate.Type }) =>
        Effect.gen(function* () {
          yield* requirePermission("contracts:write")
          const c = (yield* store.insert(TABLE, ENTITY, "ctr", payload)) as ContractRow
          yield* bus.publish("contracts.created", { id: c.id, title: c.title })
          return c
        }),
    },

    relational: {
      search: (field, value, page) =>
        Effect.gen(function* () {
          const p = yield* store.page<ContractRow>(TABLE, page, { field, value })
          return { rows: p.rows.map(summary), total: p.total }
        }),

      summaryById: (id) =>
        Effect.gen(function* () {
          const c = yield* store.byId<ContractRow>(TABLE, id)
          return c ? summary(c) : undefined
        }),

      fieldValue: (id, field) =>
        Effect.gen(function* () {
          const c = yield* store.byId<ContractRow>(TABLE, id)
          const v = c ? (c as unknown as Record<string, unknown>)[field] : null
          return typeof v === "string" ? v : null
        }),
    },
  }),
}
