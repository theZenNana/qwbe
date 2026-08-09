// The CONTACTS cube — one half of a plugin that installs two cubes at once.
//
// A plugin bringing two cubes is the case worth proving, not the one bringing one: the two land
// in the SAME flat level-0 namespace as `auth` and `notes`, each with its own database file and
// its own permissions, and neither of them is allowed to import the other. They share a
// directory on disk and nothing else — which is exactly what "the plugin is a delivery vehicle,
// not a scope" has to mean if it is to mean anything.
//
// So `contracts` is not named anywhere in this file. It holds a contact id on its side; this
// cube does not know it exists.

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization, requirePermission } from "../../../../src/kernel/auth-contract.ts"
import { EntityMeta, type SummaryRow } from "../../../../src/kernel/entity.ts"
import { Forbidden, NotFound } from "../../../../src/kernel/errors.ts"
import type { CubeDefinition, CubeTools } from "../../../../src/kernel/manifest.ts"
import { PageOf, PageParams, pageRequest } from "../../../../src/kernel/pagination.ts"

const TABLE = "contacts"
const ENTITY = "Contact"

const Contact = Schema.Struct({
  ...EntityMeta,
  name: Schema.String,
  email: Schema.String,
  /** Optional in practice, so nullable in the schema rather than absent from responses. */
  phone: Schema.NullOr(Schema.String),
  company: Schema.NullOr(Schema.String),
}).annotations({ identifier: "Contact" })

const ContactCreate = Schema.Struct({
  name: Schema.String,
  email: Schema.optionalWith(Schema.String, { default: () => "" }),
  phone: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  company: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
}).annotations({ identifier: "ContactCreate" })

type ContactRow = typeof Contact.Type

const group = HttpApiGroup.make("contacts")
  .add(HttpApiEndpoint.get("list")`/contacts`.setUrlParams(PageParams).addSuccess(PageOf(Contact)).addError(Forbidden))
  .add(
    HttpApiEndpoint.get("get")`/contacts/${HttpApiSchema.param("id", Schema.String)}`
      .addSuccess(Contact)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .add(HttpApiEndpoint.post("create")`/contacts`.setPayload(ContactCreate).addSuccess(Contact).addError(Forbidden))
  .middleware(Authorization)

// The public face of a contact. A phone number is deliberately NOT in it: a summary is shown to
// anything holding `links:read`, so whatever goes here is effectively public inside the system.
const summary = (c: ContactRow): SummaryRow => ({
  id: c.id,
  title: c.name,
  details: [
    { key: "email", value: c.email },
    { key: "company", value: c.company ?? "—" },
  ],
})

export const cube: CubeDefinition = {
  manifest: {
    name: "contacts",
    tables: [TABLE],
    entity: ENTITY,
    sortable: ["name", "company", "createdAt"],
    requiresAuth: true,
    permissions: [
      { name: "contacts:read", roles: ["admin", "reader"] },
      { name: "contacts:write", roles: ["admin"] },
    ],
    publishes: ["contacts.created"],
  },

  create: ({ store, bus }: CubeTools) => ({
    group,

    commands: [
      {
        name: "contacts:count",
        summary: "how many contacts exist",
        permission: "contacts:read",
        run: () => Effect.map(store.count(TABLE), (n) => String(n)),
      },
    ],

    handlers: {
      list: ({ urlParams }: { urlParams: typeof PageParams.Type }) =>
        Effect.gen(function* () {
          yield* requirePermission("contacts:read")
          return yield* store.page<ContactRow>(TABLE, pageRequest(urlParams))
        }),

      get: ({ path }: { path: { id: string } }) =>
        Effect.gen(function* () {
          yield* requirePermission("contacts:read")
          const c = yield* store.byId<ContactRow>(TABLE, path.id)
          if (!c) return yield* Effect.fail(new NotFound({ message: `contact ${path.id} does not exist` }))
          return c
        }),

      create: ({ payload }: { payload: typeof ContactCreate.Type }) =>
        Effect.gen(function* () {
          yield* requirePermission("contacts:write")
          const c = (yield* store.insert(TABLE, ENTITY, "cont", payload)) as ContactRow
          yield* bus.publish("contacts.created", { id: c.id, title: c.name })
          return c
        }),
    },

    relational: {
      search: (field, value, page) =>
        Effect.gen(function* () {
          const p = yield* store.page<ContactRow>(TABLE, page, { field, value })
          return { rows: p.rows.map(summary), total: p.total }
        }),

      summaryById: (id) =>
        Effect.gen(function* () {
          const c = yield* store.byId<ContactRow>(TABLE, id)
          return c ? summary(c) : undefined
        }),

      fieldValue: (id, field) =>
        Effect.gen(function* () {
          const c = yield* store.byId<ContactRow>(TABLE, id)
          const v = c ? (c as unknown as Record<string, unknown>)[field] : null
          return typeof v === "string" ? v : null
        }),
    },
  }),
}
