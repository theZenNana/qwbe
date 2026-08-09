// The CONTACTS cube — people, brought by the `cubes-erp` plugin.
//
// Common contact fields used by the demonstration ERP package:
// salutation, first and last name, the company picker, title, department, phones, emails, lead
// source, mailing address, and the two consent flags that decide whether anyone may ring or
// email them.
//
// THE DECOUPLING PROOF LIVES IN THIS FILE. `accountId` is an id and nothing else: no import, no
// entity name, no string naming the other side. What that id points at is declared one level up
// in `spaces/erp/`, by a third party. Delete the other cube and this one carries on holding an
// id that resolves to nothing — which is what the link warning at startup is for.
//
//     grep -rn "ErpAccount" contacts/   → nothing
//
// checked mechanically by `probes/erp.mjs`, the same way `probes/decoupling.mjs` checks notes.

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization, requirePermission } from "../../../../src/kernel/auth-contract.ts"
import { EntityMeta, type SummaryRow } from "../../../../src/kernel/entity.ts"
import { BadRequest, Forbidden, NotFound } from "../../../../src/kernel/errors.ts"
import type { CubeDefinition, CubeTools } from "../../../../src/kernel/manifest.ts"
import { PageOf, PageParams, pageRequest } from "../../../../src/kernel/pagination.ts"

const TABLE = "erp_contacts"
const ENTITY = "ErpContact"

const SETTINGS_REQUESTED = "erp.settings.requested"
const SETTINGS_CHANGED = "erp.settings.changed"
const KEY_PREFIX = "erp.contactNumberPrefix"

const ErpContact = Schema.Struct({
  ...EntityMeta,
  /** Human-facing number, e.g. `CON-0007`. The prefix comes from the ERP settings. */
  number: Schema.String,
  /**
   * The person's name as one string — DERIVED, never accepted from a caller.
   *
   * It is not in the create or update payloads: it is recomputed from salutation, first and last
   * name on every write, so it cannot drift from them. It exists because the row has to have a
   * name a screen can show; without it the generic detail page headed the contact's page with a
   * raw id, which looks like a bug even though nothing was wrong.
   */
  name: Schema.String,
  salutation: Schema.String,
  firstName: Schema.String,
  lastName: Schema.String,
  /**
   * The company this person belongs to — an id, held as a plain string.
   *
   * Empty means "not attached to one", which is a legitimate state in every CRM: a lead exists
   * before its company record does.
   */
  accountId: Schema.String,
  /**
   * The job title — `jobTitle`, not `title`, and the rename came from looking at the screen.
   *
   * Some CRMs call this field `title`, but the generic detail page takes `row.title` as the NAME of the
   * record: the contact's page came up headed "Director tehnic" instead of "Ionel Popescu". A
   * field name that reads as one thing to a cube and another to every screen is a trap for the
   * next cube too, so this one moved out of the way.
   */
  jobTitle: Schema.String,
  department: Schema.String,
  phone: Schema.String,
  mobile: Schema.String,
  email: Schema.String,
  leadSource: Schema.String,
  mailingCity: Schema.String,
  mailingCountry: Schema.String,
  description: Schema.String,
  doNotCall: Schema.Boolean,
  emailOptOut: Schema.Boolean,
}).annotations({ identifier: "ErpContact" })

const optionalText = Schema.optionalWith(Schema.String, { default: () => "" })
const optionalFlag = Schema.optionalWith(Schema.Boolean, { default: () => false })

const ErpContactCreate = Schema.Struct({
  lastName: Schema.String.pipe(Schema.minLength(1)),
  salutation: optionalText,
  firstName: optionalText,
  accountId: optionalText,
  jobTitle: optionalText,
  department: optionalText,
  phone: optionalText,
  mobile: optionalText,
  email: optionalText,
  leadSource: optionalText,
  mailingCity: optionalText,
  mailingCountry: optionalText,
  description: optionalText,
  doNotCall: optionalFlag,
  emailOptOut: optionalFlag,
}).annotations({ identifier: "ErpContactCreate" })

const ErpContactUpdate = Schema.partial(
  Schema.Struct({
    lastName: Schema.String.pipe(Schema.minLength(1)),
    salutation: Schema.String,
    firstName: Schema.String,
    accountId: Schema.String,
    jobTitle: Schema.String,
    department: Schema.String,
    phone: Schema.String,
    mobile: Schema.String,
    email: Schema.String,
    leadSource: Schema.String,
    mailingCity: Schema.String,
    mailingCountry: Schema.String,
    description: Schema.String,
    doNotCall: Schema.Boolean,
    emailOptOut: Schema.Boolean,
  }),
).annotations({ identifier: "ErpContactUpdate" })

type ErpContactRow = typeof ErpContact.Type

const group = HttpApiGroup.make("contacts")
  .add(
    HttpApiEndpoint.get("list")`/contacts`.setUrlParams(PageParams).addSuccess(PageOf(ErpContact)).addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.get("get")`/contacts/${HttpApiSchema.param("id", Schema.String)}`
      .addSuccess(ErpContact)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.post("create")`/contacts`.setPayload(ErpContactCreate).addSuccess(ErpContact).addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.patch("update")`/contacts/${HttpApiSchema.param("id", Schema.String)}`
      .setPayload(ErpContactUpdate)
      .addSuccess(ErpContact)
      .addError(NotFound)
      .addError(BadRequest)
      .addError(Forbidden),
  )
  .middleware(Authorization)

/** Takes a plain record, so it can be used before a row exists as well as after. */
// `?: string | undefined`, not `?: string`. Under `exactOptionalPropertyTypes` the short form
// means "absent OR a string" and rejects a property that is PRESENT and undefined — which is
// exactly what `{ ...current, ...payload }` produces for a field the caller did not send.
const fullName = (c: {
  salutation?: string | undefined
  firstName?: string | undefined
  lastName?: string | undefined
}) => [c.salutation, c.firstName, c.lastName].filter(Boolean).join(" ")

/** This cube's chosen public shape. The id it holds is shown as an id — it resolves nothing. */
const summary = (c: ErpContactRow): SummaryRow => ({
  id: c.id,
  title: fullName(c),
  details: [
    { key: "number", value: c.number },
    { key: "jobTitle", value: c.jobTitle },
    { key: "email", value: c.email },
    { key: "phone", value: c.phone },
  ],
})

export const cube: CubeDefinition = {
  manifest: {
    name: "contacts",
    tables: [TABLE],
    entity: ENTITY,
    sortable: ["number", "name", "lastName", "firstName", "jobTitle", "email", "mailingCity", "createdAt"],
    requiresAuth: true,
    permissions: [
      { name: "contacts:read", roles: ["admin", "reader"] },
      { name: "contacts:write", roles: ["admin"] },
    ],
    publishes: ["contacts.created", "contacts.updated", SETTINGS_REQUESTED],
  },

  create: ({ store, bus }: CubeTools) => {
    const settings = { numberPrefix: "CON" }
    let asked = false

    const withSettings = Effect.gen(function* () {
      if (asked) return
      asked = true
      yield* bus.publish(SETTINGS_REQUESTED, { keys: [KEY_PREFIX] })
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
            }),
        },
      ],

      commands: [
        {
          name: "contacts:count",
          summary: "how many contacts exist",
          permission: "contacts:read",
          run: () => Effect.map(store.count(TABLE), (n) => String(n)),
        },
        {
          name: "contacts:list",
          summary: "the newest contacts — `contacts:list [howMany]`",
          permission: "contacts:read",
          maxArgs: 1,
          run: (args) =>
            Effect.gen(function* () {
              const howMany = Math.min(50, Math.max(1, Number(args[0] ?? 10) || 10))
              const p = yield* store.page<ErpContactRow>(TABLE, {
                offset: 0,
                limit: howMany,
                sortBy: "createdAt",
                descending: true,
              })
              return p.rows.map((c) => `${c.number}\t${fullName(c)}\t${c.jobTitle}\t${c.email}`).join("\n") || "(none)"
            }),
        },
      ],

      handlers: {
        list: ({ urlParams }: { urlParams: typeof PageParams.Type }) =>
          Effect.gen(function* () {
            yield* requirePermission("contacts:read")
            return yield* store.page<ErpContactRow>(TABLE, pageRequest(urlParams))
          }),

        get: ({ path }: { path: { id: string } }) =>
          Effect.gen(function* () {
            yield* requirePermission("contacts:read")
            const c = yield* store.byId<ErpContactRow>(TABLE, path.id)
            if (!c) return yield* Effect.fail(new NotFound({ message: `contact ${path.id} does not exist` }))
            return c
          }),

        create: ({ payload }: { payload: typeof ErpContactCreate.Type }) =>
          Effect.gen(function* () {
            yield* requirePermission("contacts:write")
            yield* withSettings
            const number = yield* nextNumber
            const c = (yield* store.insert(TABLE, ENTITY, "cont", {
              ...payload,
              number,
              name: fullName(payload),
            })) as ErpContactRow
            yield* bus.publish("contacts.created", { id: c.id, title: fullName(c) })
            return c
          }),

        update: ({ path, payload }: { path: { id: string }; payload: typeof ErpContactUpdate.Type }) =>
          Effect.gen(function* () {
            yield* requirePermission("contacts:write")
            if (Object.keys(payload).length === 0) {
              return yield* Effect.fail(new BadRequest({ message: "patch is empty — nothing to change" }))
            }
            // The derived name is recomputed here rather than left as it was: renaming somebody
            // and keeping the old display name is the kind of half-update that makes a list and a
            // detail page disagree.
            const current = yield* store.byId<ErpContactRow>(TABLE, path.id)
            if (!current) {
              return yield* Effect.fail(new NotFound({ message: `contact ${path.id} does not exist` }))
            }
            const patch = { ...payload, name: fullName({ ...current, ...payload }) }
            const updated = yield* store.update(TABLE, path.id, patch as Record<string, unknown>)
            if (!updated) {
              return yield* Effect.fail(new NotFound({ message: `contact ${path.id} does not exist` }))
            }
            const c = updated as unknown as ErpContactRow
            yield* bus.publish("contacts.updated", { id: c.id, title: fullName(c) })
            return c
          }),
      },

      relational: {
        // How the reverse direction works: something asks the registry for "rows of `contacts`
        // whose `accountId` equals this id". The question comes from the space, not from here.
        search: (field, value, page) =>
          Effect.gen(function* () {
            const p = yield* store.page<ErpContactRow>(TABLE, page, { field, value })
            return { rows: p.rows.map(summary), total: p.total }
          }),

        summaryById: (id) =>
          Effect.gen(function* () {
            const c = yield* store.byId<ErpContactRow>(TABLE, id)
            return c ? summary(c) : undefined
          }),

        fieldValue: (id, field) =>
          Effect.gen(function* () {
            const c = yield* store.byId<ErpContactRow>(TABLE, id)
            const v = c ? (c as unknown as Record<string, unknown>)[field] : null
            return typeof v === "string" ? v : null
          }),
      },
    }
  },
}
