// The NOTES cube — the example. Small, genuinely useful, and taken as a shape from the
// smallest real unit in the previous system (405 lines there).
//
// It matters for one more reason: a link needs two entities. Notes plus Account is the smallest
// pair that lets a space declare a real connection.
//
// Look for the word "Account" in this file. It is not here — not in an import, not in a string,
// not in the manifest. `notes` holds an `authorId` and knows nothing about what it points at.
// The connection is declared one level up, in `spaces/workspace/`, by neither party.
// This is checked mechanically: `probes/decoupling.mjs` greps for it.

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization, CurrentUser, requirePermission } from "../../kernel/auth-contract.ts"
import { EntityMeta, type SummaryRow } from "../../kernel/entity.ts"
import { Forbidden, NotFound } from "../../kernel/errors.ts"
import type { CubeDefinition, CubeTools } from "../../kernel/manifest.ts"
import { PageOf, PageParams, pageRequest } from "../../kernel/pagination.ts"

const TABLE = "notes"
const ENTITY = "Note"

const Note = Schema.Struct({
  ...EntityMeta,
  title: Schema.String,
  body: Schema.String,
  /** Whose note it is. Just an id — nothing copied from the other side. */
  authorId: Schema.NullOr(Schema.String),
}).annotations({ identifier: "Note" })

const NoteCreate = Schema.Struct({
  title: Schema.String,
  body: Schema.optionalWith(Schema.String, { default: () => "" }),
}).annotations({ identifier: "NoteCreate" })

type NoteRow = typeof Note.Type

const group = HttpApiGroup.make("notes")
  .add(HttpApiEndpoint.get("list")`/notes`.setUrlParams(PageParams).addSuccess(PageOf(Note)).addError(Forbidden))
  .add(
    HttpApiEndpoint.get("get")`/notes/${HttpApiSchema.param("id", Schema.String)}`
      .addSuccess(Note)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .add(HttpApiEndpoint.post("create")`/notes`.setPayload(NoteCreate).addSuccess(Note).addError(Forbidden))
  .middleware(Authorization)

const summary = (n: NoteRow): SummaryRow => ({
  id: n.id,
  title: n.title,
  details: [
    { key: "body", value: n.body.length > 60 ? `${n.body.slice(0, 60)}…` : n.body },
    { key: "created", value: n.createdAt.slice(0, 10) },
  ],
})

export const cube: CubeDefinition = {
  manifest: {
    name: "notes",
    tables: [TABLE],
    entity: ENTITY,
    // Sorting reads the stored row, so only these are offered. `body` is content, not an
    // index, but it is already public — the point of the list is to keep hidden columns out.
    sortable: ["title", "createdAt"],
    requiresAuth: true,
    permissions: [
      { name: "notes:read", roles: ["admin", "reader"] },
      { name: "notes:write", roles: ["admin"] },
    ],
    publishes: ["notes.created"],
  },

  create: ({ store, bus }: CubeTools) => ({
    group,

    commands: [
      {
        name: "notes:count",
        summary: "how many notes exist",
        permission: "notes:read",
        run: () => Effect.map(store.count(TABLE), (n) => String(n)),
      },
      {
        name: "notes:recent",
        summary: "the newest notes — `notes:recent [howMany]`",
        permission: "notes:read",
        maxArgs: 1,
        run: (args) =>
          Effect.gen(function* () {
            const howMany = Math.min(20, Math.max(1, Number(args[0] ?? 5) || 5))
            const p = yield* store.page<NoteRow>(TABLE, {
              offset: 0,
              limit: howMany,
              sortBy: "createdAt",
              descending: true,
            })
            return p.rows.map((n) => `${n.createdAt.slice(0, 16).replace("T", " ")}  ${n.title}`).join("\n") || "(none)"
          }),
      },
    ],

    handlers: {
      list: ({ urlParams }: { urlParams: typeof PageParams.Type }) =>
        Effect.gen(function* () {
          yield* requirePermission("notes:read")
          return yield* store.page<NoteRow>(TABLE, pageRequest(urlParams))
        }),

      get: ({ path }: { path: { id: string } }) =>
        Effect.gen(function* () {
          yield* requirePermission("notes:read")
          const n = yield* store.byId<NoteRow>(TABLE, path.id)
          if (!n) return yield* Effect.fail(new NotFound({ message: `note ${path.id} does not exist` }))
          return n
        }),

      create: ({ payload }: { payload: typeof NoteCreate.Type }) =>
        Effect.gen(function* () {
          yield* requirePermission("notes:write")
          // The author is whoever is logged in. `CurrentUser` comes from the kernel contract,
          // so this cube gets an author id without knowing which cube issues identities.
          const user = yield* CurrentUser
          const n = (yield* store.insert(TABLE, ENTITY, "note", { ...payload, authorId: user.id })) as NoteRow
          yield* bus.publish("notes.created", { id: n.id, title: n.title })
          return n
        }),
    },

    relational: {
      search: (field, value, page) =>
        Effect.gen(function* () {
          const p = yield* store.page<NoteRow>(TABLE, page, { field, value })
          return { rows: p.rows.map(summary), total: p.total }
        }),

      summaryById: (id) =>
        Effect.gen(function* () {
          const n = yield* store.byId<NoteRow>(TABLE, id)
          return n ? summary(n) : undefined
        }),

      fieldValue: (id, field) =>
        Effect.gen(function* () {
          const n = yield* store.byId<NoteRow>(TABLE, id)
          const v = n ? (n as unknown as Record<string, unknown>)[field] : null
          return typeof v === "string" ? v : null
        }),
    },
  }),
}
