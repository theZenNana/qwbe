// The NOTES cube — the example. Small, genuinely useful, and taken as a shape from the
// smallest real unit in the previous system (405 lines there).
//
// It matters for one more reason: a link needs two entities. Notes plus Account is the smallest
// pair that lets a space declare a real connection.
//
// Look for the word "Account" in this file. It is not here — not in an import, not in a string,
// not in the manifest. `notes` holds an `authorId` and knows nothing about what it points at.
// The connection is declared one level up, in `spaces/workspace/`, by neither party.
// This is checked mechanically: `npm run boundaries` (rule `no-cube-to-cube`) refuses the import.

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Layer, Schema } from "effect"
import { Authorization, CurrentUser, requirePermission } from "qwbe-core/auth"
import { type CubeTools, defineCube } from "qwbe-core/cube"
import { EntityMeta, type SummaryRow } from "qwbe-core/entity"
import { Forbidden, NotFound } from "qwbe-core/errors"
import { PageOf } from "qwbe-core/http"
import { PageParams, pageRequest } from "qwbe-core/pagination"
import { requireTool, storeRelational } from "../shared.ts"
import { notesCommands } from "./commands.ts"
import { migrateLegacyNotes } from "./permissions.ts"

const TABLE = "notes"
const ENTITY = "Note"

// Route permissions, published by the metadata and checked by the handlers (see metadata/declarations.ts).
const ROUTES = {
  list: "notes:read",
  get: "notes:read",
  create: "notes:write",
} as const

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

const NoteListParams = Schema.Struct({
  ...PageParams.fields,
  /** `ids=a,b,c` -- only these notes. The entity wrapper injects the actor's visible ids here. */
  ids: Schema.optional(Schema.String),
})

const group = HttpApiGroup.make("notes")
  .add(HttpApiEndpoint.get("list")`/notes`.setUrlParams(NoteListParams).addSuccess(PageOf(Note)).addError(Forbidden))
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
    { key: "body", value: n.body.length > 60 ? `${n.body.slice(0, 60)}...` : n.body },
    { key: "created", value: n.createdAt.slice(0, 10) },
  ],
})

export const cube = defineCube(group, {
  manifest: {
    name: "notes",
    // Declares a version, which opts the cube into the drift gate (schema-drift.ts).
    version: "1.0.0",
    tables: [TABLE],
    indexed: { [TABLE]: ["authorId"] },
    entity: ENTITY,
    // Sorting reads the stored row, so only these are offered. `body` is content, not an
    // index, but it is already public -- the point of the list is to keep hidden columns out.
    sortable: ["title", "createdAt"],
    requiresAuth: true,
    permissions: [
      { name: "notes:read", roles: ["admin", "reader"] },
      { name: "notes:write", roles: ["admin"] },
    ],
    routes: ROUTES,
    publishes: ["notes.created"],
    usesEntityPermissions: true,
  },

  create: (tools: CubeTools) => {
    const { store, bus } = tools
    const entityPermissions = requireTool(tools.entityPermissions, "notes requires the entity permissions capability")
    const stored = storeRelational<NoteRow>(store, TABLE, summary)
    const actor = (user: CurrentUser["Type"]) => ({ userId: user.id, roles: user.roles })
    const reference = (note: NoteRow) => ({ cube: "notes", entityType: ENTITY, entityId: note.id })

    return {
      commands: notesCommands(store),
      // Legacy notes get an owner here, once, at boot; `create` claims every new note.
      layers: Layer.effectDiscard(migrateLegacyNotes<NoteRow>(store, entityPermissions)),

      handlers: {
        // The entity wrapper authorizes, injects the visible `ids` and writes the audit row (Qwbe#73).
        list: ({ urlParams }: { urlParams: typeof NoteListParams.Type }) =>
          Effect.gen(function* () {
            yield* requirePermission(ROUTES.list)
            // Filter, sort (the manifest's `sortable`), count and page all in SQL.
            const { rows, total, offset, limit, sortedBy } = yield* store.page<NoteRow>(TABLE, pageRequest(urlParams), {
              ids: (urlParams.ids ?? "").split(",").filter(Boolean),
            })
            return { rows, total, offset, limit, sortedBy }
          }),

        get: ({ path }: { path: { id: string } }) =>
          Effect.gen(function* () {
            yield* requirePermission(ROUTES.get)
            const user = yield* CurrentUser
            const n = yield* store.byId<NoteRow>(TABLE, path.id)
            if (!n) return yield* Effect.fail(new NotFound({ message: `note ${path.id} does not exist` }))
            const ref = reference(n)
            if (!(yield* entityPermissions.authorize(actor(user), ref, "read").pipe(Effect.orDie)).allowed) {
              return yield* Effect.fail(
                new Forbidden({ message: "this note is not shared with you", needed: "notes:read" }),
              )
            }
            return n
          }),

        create: ({ payload }: { payload: typeof NoteCreate.Type }) =>
          Effect.gen(function* () {
            yield* requirePermission(ROUTES.create)
            // The author is whoever is logged in. `CurrentUser` comes from the kernel contract,
            // so this cube gets an author id without knowing which cube issues identities.
            const user = yield* CurrentUser
            const n = (yield* store.insert(TABLE, ENTITY, "note", { ...payload, authorId: user.id })) as NoteRow
            yield* entityPermissions.claim(actor(user), reference(n)).pipe(Effect.orDie)
            yield* bus.publish("notes.created", { id: n.id, title: n.title })
            return n
          }),
      },

      relational: {
        search: (field, value, page) =>
          Effect.gen(function* () {
            const user = yield* CurrentUser
            // `field` is a declared link (workspace: `authorId`) and `value` an id, both strings,
            // so the SQL text compare matches the old in-memory `String(...) === value`.
            const matching = yield* store.where<NoteRow>(TABLE, { field, value })
            const rows = yield* Effect.filter(matching, (note) =>
              Effect.gen(function* () {
                const ref = reference(note)
                if (!(yield* entityPermissions.ownership(ref)) && note.authorId) {
                  yield* entityPermissions.claim({ userId: note.authorId, roles: user.roles }, ref).pipe(Effect.orDie)
                }
                return (yield* entityPermissions.authorize(actor(user), ref, "read").pipe(Effect.orDie)).allowed
              }),
            )
            return { rows: rows.slice(page.offset, page.offset + page.limit).map(summary), total: rows.length }
          }),

        summaryById: stored.summaryById,
        fieldValue: stored.fieldValue,
      },
    }
  },
})
