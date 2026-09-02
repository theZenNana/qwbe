// The first child of Booktags (docs/booktags-hierarchy.md).
//
// Same cube it was as a flat plugin cube -- contract, handlers, a command, a public entity --
// with three changes that are the point of the hierarchy:
//
//   1. `parent: "booktags"` in the manifest, checked at mount against the real directory.
//   2. Its permissions, command and events carry the compound prefix `booktags/bookmarks:` --
//      one namespace mechanism, one level deeper.
//   3. A bookmark now points at a REAL mounted cube (`targetCube`), validated against the
//      catalogue by name -- never by import. "Bookmark another Qwbe cube and navigate back to
//      it" is the product behaviour; an arbitrary URL stays available as `url`.

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization, requirePermission } from "qwbe-core/auth"
import { type CubeTools, defineCube } from "qwbe-core/cube"
import { EntityMeta, type SummaryRow } from "qwbe-core/entity"
import { BadRequest, Forbidden, NotFound } from "qwbe-core/errors"
import { PageOf } from "qwbe-core/http"
import { genericList, ListParams } from "qwbe-core/list"
import { decodeBooktagsSettingChanged } from "../events.ts"

const TABLE = "bookmarks"
const CACHE = "settings-cache"
const ENTITY = "Bookmark"
const PREFIX = "booktags/bookmarks"

const Bookmark = Schema.Struct({
  ...EntityMeta,
  label: Schema.String,
  /** Name of the mounted cube this bookmark navigates back to -- a string, not an import.
   *  Optional: rows written before the hierarchy existed carry only a URL, and the list
   *  must still answer for them. */
  targetCube: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
}).annotations({ identifier: "Bookmark" })

const BookmarkCreate = Schema.Struct({
  label: Schema.String,
  targetCube: Schema.String,
  url: Schema.optionalWith(Schema.String, { default: () => "" }),
}).annotations({ identifier: "BookmarkCreate" })

type BookmarkRow = typeof Bookmark.Type

const group = HttpApiGroup.make("bookmarks")
  .add(
    HttpApiEndpoint.get("list")`/bookmarks`.setUrlParams(ListParams).addSuccess(PageOf(Bookmark)).addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.get("get")`/bookmarks/${HttpApiSchema.param("id", Schema.String)}`
      .addSuccess(Bookmark)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.post("create")`/bookmarks`
      .setPayload(BookmarkCreate)
      .addSuccess(Bookmark)
      .addError(BadRequest)
      .addError(Forbidden),
  )
  .middleware(Authorization)

const summary = (b: BookmarkRow): SummaryRow => ({
  id: b.id,
  title: b.label,
  details: [{ key: "targetCube", value: b.targetCube ?? "" }],
})

// Declared routes: the mount wrapper enforces before the handler runs -- the same strings
// the handlers below require. `list` is not declared: the kernel's read convention applies.
const ROUTES = { create: "booktags/bookmarks:write" } as const

const manifest = {
  name: "bookmarks",
  // Opts the cube into the metadata drift gate (see src/metadata/schema-drift.ts).
  version: "1.0.0",
  parent: "booktags",
  // `settings-cache` holds the sibling's published configuration -- written by this cube's
  // own subscription, never touched by the settings cube. Owned here like any other table.
  tables: [TABLE, CACHE],
  entity: ENTITY,
  sortable: ["label", "targetCube"],
  requiresAuth: true,
  permissions: [
    { name: "booktags/bookmarks:read", roles: ["admin", "reader"] },
    { name: "booktags/bookmarks:write", roles: ["admin"] },
  ],
  routes: ROUTES,
  publishes: ["booktags/bookmarks.created"],
} as const

export const cube = defineCube(group, {
  manifest,

  create: ({ store, bus, catalogue }: CubeTools) => ({
    commands: [
      {
        name: "booktags/bookmarks:count",
        summary: "how many bookmarks exist (child of booktags)",
        permission: "booktags/bookmarks:read",
        run: () => Effect.map(store.count(TABLE), (n) => String(n)),
      },
    ],

    // The sibling's configuration arrives as an event and is kept in THIS cube's own store --
    // one of the four legal paths between cubes. `booktags/settings` never opens this table,
    // and this cube never imports the settings cube. Deleting the settings cube leaves this
    // one running on its default ("relaxed"), honestly.
    subscriptions: [
      {
        event: "booktags/settings.changed",
        handle: (payload) =>
          Effect.gen(function* () {
            // Decoded against the kernel's contract, never cast. A payload that does not
            // match dies here -- caught by the bus, logged, delivery continues.
            const { key, value } = decodeBooktagsSettingChanged(payload)
            const rows = yield* store.all<{ id: string; key: string }>(CACHE)
            const existing = rows.find((r) => r.key === key)
            if (existing) yield* store.update(CACHE, existing.id, { value })
            else yield* store.insert(CACHE, "BooktagsSettingCache", "bsc", { key, value })
          }),
      },
    ],

    handlers: {
      // The kernel's list, generated from the manifest above (QWB-54).
      list: genericList<BookmarkRow>({ cube: "booktags/bookmarks", table: TABLE, manifest, store }),

      get: ({ path }: { path: { id: string } }) =>
        Effect.gen(function* () {
          yield* requirePermission("booktags/bookmarks:read")
          const bookmark = yield* store.byId<BookmarkRow>(TABLE, path.id)
          if (!bookmark) {
            return yield* Effect.fail(new NotFound({ message: `bookmark ${path.id} does not exist` }))
          }
          return bookmark
        }),

      create: ({ payload }: { payload: typeof BookmarkCreate.Type }) =>
        Effect.gen(function* () {
          yield* requirePermission("booktags/bookmarks:write")
          // The target must be a real, mounted cube -- checked against the catalogue by name.
          // A bookmark pointing nowhere is refused here rather than becoming a dead link.
          const mounted = catalogue().some((c) => c.name === payload.targetCube)
          if (!mounted) {
            return yield* Effect.fail(
              new BadRequest({
                message: `no mounted cube named "${payload.targetCube}" -- a bookmark points at a real cube`,
              }),
            )
          }
          // Booktags' own setting, configured in the `booktags/settings` child: in "strict"
          // mode a bookmark is a cube reference only -- an arbitrary URL is refused.
          const cache = yield* store.all<{ key: string; value: string }>(CACHE)
          const strict = cache.find((r) => r.key === "enforceTargetCube")?.value === "strict"
          if (strict && payload.url !== undefined && payload.url !== "") {
            return yield* Effect.fail(
              new BadRequest({
                message: `booktags is in strict mode: a bookmark points at a cube, not an arbitrary URL`,
              }),
            )
          }
          const b = (yield* store.insert(TABLE, ENTITY, "bm", payload)) as BookmarkRow
          yield* bus.publish(`${PREFIX}.created`, { id: b.id, title: b.label })
          return b
        }),
    },

    relational: {
      search: (field, value, page) =>
        Effect.gen(function* () {
          const p = yield* store.page<BookmarkRow>(TABLE, page, { field, value })
          return { rows: p.rows.map(summary), total: p.total }
        }),
      summaryById: (id) =>
        Effect.gen(function* () {
          const b = yield* store.byId<BookmarkRow>(TABLE, id)
          return b ? summary(b) : undefined
        }),
    },
  }),
})
