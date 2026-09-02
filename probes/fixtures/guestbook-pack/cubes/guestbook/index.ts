// The GUESTBOOK fixture cube -- the customfields probe's target (QWB-46 review fix 20).
//
// Before this fixture, the acceptance probe refused to run unless an untracked crm-pack
// install existed under core/plugins, so the stated acceptance criterion could not run on CI
// or a fresh checkout. A cube with one declared field and plain role permissions is all the
// walk needs: values are folded into ITS rows, and nothing about the fold is crm-specific.
// Deliberately minimal: no entity permissions, no links, no commands -- it exists to hold rows.

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization, requirePermission } from "qwbe-core/auth"
import { type CubeTools, defineCube } from "qwbe-core/cube"
import { EntityMeta, type SummaryRow } from "qwbe-core/entity"
import { Forbidden, NotFound } from "qwbe-core/errors"
import { PageOf } from "qwbe-core/http"
import { PageParams, pageRequest } from "qwbe-core/pagination"

const TABLE = "guestbook"
const ENTITY = "GuestbookEntry"

const Entry = Schema.Struct({
  ...EntityMeta,
  name: Schema.String,
}).annotations({ identifier: "GuestbookEntry" })

const EntryCreate = Schema.Struct({ name: Schema.String }).annotations({ identifier: "GuestbookEntryCreate" })

type EntryRow = typeof Entry.Type

const group = HttpApiGroup.make("guestbook")
  .add(HttpApiEndpoint.get("list")`/guestbook`.setUrlParams(PageParams).addSuccess(PageOf(Entry)).addError(Forbidden))
  .add(
    HttpApiEndpoint.get("get")`/guestbook/${HttpApiSchema.param("id", Schema.String)}`
      .addSuccess(Entry)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.patch("patch")`/guestbook/${HttpApiSchema.param("id", Schema.String)}`
      .setPayload(Schema.partial(EntryCreate))
      .addSuccess(Entry)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .add(HttpApiEndpoint.post("create")`/guestbook`.setPayload(EntryCreate).addSuccess(Entry).addError(Forbidden))
  .middleware(Authorization)

const summary = (e: EntryRow): SummaryRow => ({ id: e.id, title: e.name, details: [] })

export const cube = defineCube(group, {
  manifest: {
    name: "guestbook",
    tables: [TABLE],
    entity: ENTITY,
    sortable: ["name", "createdAt"],
    requiresAuth: true,
    permissions: [
      { name: "guestbook:read", roles: ["admin", "reader"] },
      { name: "guestbook:write", roles: ["admin"] },
    ],
    // Declared routes: the mount wrapper enforces before the handler runs -- the same strings
    // the get/patch/create handlers below require. `list` rides the kernel's read convention.
    routes: { get: "guestbook:read", patch: "guestbook:write", create: "guestbook:write" },
  },

  create: ({ store }: CubeTools) => ({
    handlers: {
      list: ({ urlParams }: { urlParams: typeof PageParams.Type }) =>
        Effect.gen(function* () {
          yield* requirePermission("guestbook:read")
          // Entity mediation makes the no-param GET the entity list itself: full rows.
          const page = yield* store.page<EntryRow>(TABLE, pageRequest(urlParams))
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
          yield* requirePermission("guestbook:read")
          const row = yield* store.byId<EntryRow>(TABLE, path.id)
          if (!row) return yield* Effect.fail(new NotFound({ message: `no guestbook entry ${path.id}` }))
          return row
        }),

      patch: ({ path, payload }: { path: { readonly id: string }; payload: Record<string, unknown> }) =>
        Effect.gen(function* () {
          yield* requirePermission("guestbook:write")
          const row = yield* store.update(TABLE, path.id, payload)
          if (!row) return yield* Effect.fail(new NotFound({ message: `no guestbook entry ${path.id}` }))
          return row as EntryRow
        }),

      create: ({ payload }: { payload: typeof EntryCreate.Type }) =>
        Effect.gen(function* () {
          yield* requirePermission("guestbook:write")
          // `custom` rides in the payload the kernel's fold produced; the store persists it as
          // part of the row body, exactly like any declared field.
          const custom = (payload as { custom?: Record<string, unknown> }).custom
          return (yield* store.insert(TABLE, ENTITY, "gb", { name: payload.name, custom })) as EntryRow
        }),
    },

    relational: {
      search: (field, value, page) =>
        Effect.gen(function* () {
          const p = yield* store.page<EntryRow>(TABLE, page, { field, value })
          return { rows: p.rows.map(summary), total: p.total }
        }),
      summaryById: (id) =>
        Effect.gen(function* () {
          const row = yield* store.byId<EntryRow>(TABLE, id)
          return row ? summary(row) : undefined
        }),
    },
  }),
})
