// The ACCOUNTS cube — companies, brought by the `cubes-erp` plugin.
//
// "Account" in a CRM sense: a company you sell to or buy from. The payload uses common company
// fields and remains independent of any external installation.
//
// It is deliberately NOT called `account`: core already ships a cube with that name holding the
// `Account` entity, which means a USER of the system. Two cubes cannot share a name, a table or
// (silently) an entity — so this one is `accounts`, owns `erp_accounts`, and publishes
// `ErpAccount`. The confusion between "a user" and "a company" is the oldest bug in every CRM
// and here it is settled by naming rather than by convention.
//
// The word "Contact" does not appear in this file. Contacts point at accounts, and that link is
// declared by a third party in `spaces/erp/`. This cube does not know contacts exist.

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization, requirePermission } from "../../../../src/kernel/auth-contract.ts"
import { EntityMeta, type SummaryRow } from "../../../../src/kernel/entity.ts"
import { BadRequest, Forbidden, NotFound } from "../../../../src/kernel/errors.ts"
import type { CubeDefinition, CubeTools } from "../../../../src/kernel/manifest.ts"
import { PageOf, PageParams, pageRequest } from "../../../../src/kernel/pagination.ts"

const TABLE = "erp_accounts"
const ENTITY = "ErpAccount"

/** Asked for once, answered over the bus by whoever holds the ERP settings — see below. */
const SETTINGS_REQUESTED = "erp.settings.requested"
const SETTINGS_CHANGED = "erp.settings.changed"

const KEY_PREFIX = "erp.accountNumberPrefix"
const KEY_INDUSTRY = "erp.defaultIndustry"

/**
 * `type` is NOT a field name here, and that is not a style choice.
 *
 * The store writes `{ id, type, createdAt, deleted, ...values }`, so a payload field called
 * `type` overwrites the entity type of the row — the row stops being an `ErpAccount` and the
 * registry can no longer find it. The business classification field is
 * `accountType` for the same reason, arrived at by reading `kernel/store.ts` rather than by
 * finding out later.
 */
const ErpAccount = Schema.Struct({
  ...EntityMeta,
  /** Human-facing number, e.g. `ACC-0007`. The prefix comes from the ERP settings. */
  number: Schema.String,
  name: Schema.String,
  phone: Schema.String,
  website: Schema.String,
  email: Schema.String,
  industry: Schema.String,
  rating: Schema.String,
  accountType: Schema.String,
  employees: Schema.String,
  annualRevenue: Schema.String,
  billStreet: Schema.String,
  billCity: Schema.String,
  billCountry: Schema.String,
  description: Schema.String,
  /** Who owns the relationship. An id from whatever cube issues identities — a string here. */
  assignedTo: Schema.String,
}).annotations({ identifier: "ErpAccount" })

const optionalText = Schema.optionalWith(Schema.String, { default: () => "" })

const ErpAccountCreate = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1)),
  phone: optionalText,
  website: optionalText,
  email: optionalText,
  industry: optionalText,
  rating: optionalText,
  accountType: optionalText,
  employees: optionalText,
  annualRevenue: optionalText,
  billStreet: optionalText,
  billCity: optionalText,
  billCountry: optionalText,
  description: optionalText,
  assignedTo: optionalText,
}).annotations({ identifier: "ErpAccountCreate" })

/** Every field optional: a patch says what changes, not what the row is. */
const ErpAccountUpdate = Schema.partial(
  Schema.Struct({
    name: Schema.String.pipe(Schema.minLength(1)),
    phone: Schema.String,
    website: Schema.String,
    email: Schema.String,
    industry: Schema.String,
    rating: Schema.String,
    accountType: Schema.String,
    employees: Schema.String,
    annualRevenue: Schema.String,
    billStreet: Schema.String,
    billCity: Schema.String,
    billCountry: Schema.String,
    description: Schema.String,
    assignedTo: Schema.String,
  }),
).annotations({ identifier: "ErpAccountUpdate" })

type ErpAccountRow = typeof ErpAccount.Type

const group = HttpApiGroup.make("accounts")
  .add(
    HttpApiEndpoint.get("list")`/accounts`.setUrlParams(PageParams).addSuccess(PageOf(ErpAccount)).addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.get("get")`/accounts/${HttpApiSchema.param("id", Schema.String)}`
      .addSuccess(ErpAccount)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.post("create")`/accounts`.setPayload(ErpAccountCreate).addSuccess(ErpAccount).addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.patch("update")`/accounts/${HttpApiSchema.param("id", Schema.String)}`
      .setPayload(ErpAccountUpdate)
      .addSuccess(ErpAccount)
      .addError(NotFound)
      .addError(BadRequest)
      .addError(Forbidden),
  )
  .middleware(Authorization)

/**
 * The PUBLIC representation, chosen by this cube. Anything with `links:read` can obtain it, so
 * it carries only what is safe to show — the same rule the core `account` cube learned the hard
 * way when its summary leaked a password hash.
 */
const summary = (a: ErpAccountRow): SummaryRow => ({
  id: a.id,
  title: a.name,
  details: [
    { key: "number", value: a.number },
    { key: "city", value: a.billCity },
    { key: "phone", value: a.phone },
    { key: "website", value: a.website },
  ],
})

export const cube: CubeDefinition = {
  manifest: {
    name: "accounts",
    tables: [TABLE],
    entity: ENTITY,
    // Only public columns. Sorting reads the stored row rather than the response, so a field
    // omitted from the response but present here would be an oracle on a value nobody can read.
    sortable: ["number", "name", "industry", "billCity", "phone", "email", "createdAt"],
    requiresAuth: true,
    permissions: [
      { name: "accounts:read", roles: ["admin", "reader"] },
      { name: "accounts:write", roles: ["admin"] },
    ],
    publishes: ["accounts.created", "accounts.updated", SETTINGS_REQUESTED],
  },

  create: ({ store, bus }: CubeTools) => {
    /**
     * ERP settings, as this cube sees them.
     *
     * It cannot read another cube's database — that is the whole isolation — and a settings key
     * is not relational data, so the registry is the wrong channel too. What is left is the bus,
     * which is exactly what it is for: this cube asks once, in a string, and whoever holds the
     * ERP settings answers in a string. With no settings cube mounted, nobody answers and the
     * defaults below stand — "decoupled" means "not there", not "crashed".
     */
    const settings = { numberPrefix: "ACC", defaultIndustry: "" }
    let asked = false

    const withSettings = Effect.gen(function* () {
      if (asked) return
      // Set BEFORE publishing: a listener that publishes back reaches this cube synchronously,
      // and asking again from inside the answer would loop.
      asked = true
      yield* bus.publish(SETTINGS_REQUESTED, { keys: [KEY_PREFIX, KEY_INDUSTRY] })
    })

    const nextNumber = Effect.gen(function* () {
      const n = (yield* store.count(TABLE)) + 1
      return `${settings.numberPrefix}-${String(n).padStart(4, "0")}`
    })

    return {
      group,

      subscriptions: [
        {
          event: SETTINGS_CHANGED,
          handle: (payload: unknown) =>
            Effect.sync(() => {
              const p = payload as { key?: unknown; value?: unknown }
              if (typeof p?.key !== "string" || typeof p?.value !== "string") return
              if (p.key === KEY_PREFIX && p.value.length > 0) settings.numberPrefix = p.value
              if (p.key === KEY_INDUSTRY) settings.defaultIndustry = p.value
            }),
        },
      ],

      commands: [
        {
          name: "accounts:count",
          summary: "how many ERP accounts (companies) exist",
          permission: "accounts:read",
          run: () => Effect.map(store.count(TABLE), (n) => String(n)),
        },
        {
          name: "accounts:list",
          summary: "the newest accounts — `accounts:list [howMany]`",
          permission: "accounts:read",
          maxArgs: 1,
          run: (args) =>
            Effect.gen(function* () {
              const howMany = Math.min(50, Math.max(1, Number(args[0] ?? 10) || 10))
              const p = yield* store.page<ErpAccountRow>(TABLE, {
                offset: 0,
                limit: howMany,
                sortBy: "createdAt",
                descending: true,
              })
              return p.rows.map((a) => `${a.number}\t${a.name}\t${a.billCity}\t${a.phone}`).join("\n") || "(none)"
            }),
        },
      ],

      handlers: {
        list: ({ urlParams }: { urlParams: typeof PageParams.Type }) =>
          Effect.gen(function* () {
            yield* requirePermission("accounts:read")
            return yield* store.page<ErpAccountRow>(TABLE, pageRequest(urlParams))
          }),

        get: ({ path }: { path: { id: string } }) =>
          Effect.gen(function* () {
            yield* requirePermission("accounts:read")
            const a = yield* store.byId<ErpAccountRow>(TABLE, path.id)
            if (!a) return yield* Effect.fail(new NotFound({ message: `account ${path.id} does not exist` }))
            return a
          }),

        create: ({ payload }: { payload: typeof ErpAccountCreate.Type }) =>
          Effect.gen(function* () {
            yield* requirePermission("accounts:write")
            yield* withSettings
            const number = yield* nextNumber
            const a = (yield* store.insert(TABLE, ENTITY, "acct", {
              ...payload,
              number,
              industry: payload.industry || settings.defaultIndustry,
            })) as ErpAccountRow
            yield* bus.publish("accounts.created", { id: a.id, title: a.name })
            return a
          }),

        update: ({ path, payload }: { path: { id: string }; payload: typeof ErpAccountUpdate.Type }) =>
          Effect.gen(function* () {
            yield* requirePermission("accounts:write")
            // An empty patch is refused rather than answered with the unchanged row: silently
            // accepting a request that does nothing is the failure mode this prototype calls a
            // defect at the CLI gate, so it cannot be acceptable here either.
            if (Object.keys(payload).length === 0) {
              return yield* Effect.fail(new BadRequest({ message: "patch is empty — nothing to change" }))
            }
            const updated = yield* store.update(TABLE, path.id, payload as Record<string, unknown>)
            if (!updated) {
              return yield* Effect.fail(new NotFound({ message: `account ${path.id} does not exist` }))
            }
            const a = updated as unknown as ErpAccountRow
            yield* bus.publish("accounts.updated", { id: a.id, title: a.name })
            return a
          }),
      },

      relational: {
        search: (field, value, page) =>
          Effect.gen(function* () {
            const p = yield* store.page<ErpAccountRow>(TABLE, page, { field, value })
            return { rows: p.rows.map(summary), total: p.total }
          }),

        summaryById: (id) =>
          Effect.gen(function* () {
            const a = yield* store.byId<ErpAccountRow>(TABLE, id)
            return a ? summary(a) : undefined
          }),

        fieldValue: (id, field) =>
          Effect.gen(function* () {
            const a = yield* store.byId<ErpAccountRow>(TABLE, id)
            const v = a ? (a as unknown as Record<string, unknown>)[field] : null
            return typeof v === "string" ? v : null
          }),
      },
    }
  },
}
