// A cube that arrived in a PLUGIN, not with core.
//
// It sits in `plugins/example-plugin/cubes/bookmarks/`, yet lands in the SAME flat level-0
// namespace as `auth`, `account` and the rest. Same tools, same rules, same treatment: it gets
// its own database file, its permissions are aggregated into `auth`, its command shows up in
// the CLI, and its tab appears in the frontend.
//
// Nothing was registered anywhere to make that happen. Installing a plugin is copying a
// directory; `probes/plugin.mjs` copies this one at runtime and checks the tab appears.
//
// It exists to prove the plugin path works, so it is deliberately tiny — but it is a real cube,
// not a stub: contract, handlers, a command, and a public entity.

import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization, requirePermission } from "../../../../src/kernel/auth-contract.ts"
import { EntityMeta, type SummaryRow } from "../../../../src/kernel/entity.ts"
import { Forbidden } from "../../../../src/kernel/errors.ts"
import type { CubeDefinition, CubeTools } from "../../../../src/kernel/manifest.ts"
import { PageOf, PageParams, pageRequest } from "../../../../src/kernel/pagination.ts"

const TABLE = "bookmarks"
const ENTITY = "Bookmark"

const Bookmark = Schema.Struct({
  ...EntityMeta,
  label: Schema.String,
  url: Schema.String,
}).annotations({ identifier: "Bookmark" })

const BookmarkCreate = Schema.Struct({
  label: Schema.String,
  url: Schema.String,
}).annotations({ identifier: "BookmarkCreate" })

type BookmarkRow = typeof Bookmark.Type

const group = HttpApiGroup.make("bookmarks")
  .add(
    HttpApiEndpoint.get("list")`/bookmarks`.setUrlParams(PageParams).addSuccess(PageOf(Bookmark)).addError(Forbidden),
  )
  .add(HttpApiEndpoint.post("create")`/bookmarks`.setPayload(BookmarkCreate).addSuccess(Bookmark).addError(Forbidden))
  .middleware(Authorization)

const summary = (b: BookmarkRow): SummaryRow => ({
  id: b.id,
  title: b.label,
  details: [{ key: "url", value: b.url }],
})

export const cube: CubeDefinition = {
  manifest: {
    name: "bookmarks",
    tables: [TABLE],
    entity: ENTITY,
    sortable: ["label", "url"],
    requiresAuth: true,
    permissions: [
      { name: "bookmarks:read", roles: ["admin", "reader"] },
      { name: "bookmarks:write", roles: ["admin"] },
    ],
    publishes: ["bookmarks.created"],
  },

  create: ({ store, bus }: CubeTools) => ({
    group,

    commands: [
      {
        name: "bookmarks:count",
        summary: "how many bookmarks exist (from a plugin cube)",
        permission: "bookmarks:read",
        run: () => Effect.map(store.count(TABLE), (n) => String(n)),
      },
    ],

    handlers: {
      list: ({ urlParams }: { urlParams: typeof PageParams.Type }) =>
        Effect.gen(function* () {
          yield* requirePermission("bookmarks:read")
          return yield* store.page<BookmarkRow>(TABLE, pageRequest(urlParams))
        }),

      create: ({ payload }: { payload: typeof BookmarkCreate.Type }) =>
        Effect.gen(function* () {
          yield* requirePermission("bookmarks:write")
          const b = (yield* store.insert(TABLE, ENTITY, "bm", payload)) as BookmarkRow
          yield* bus.publish("bookmarks.created", { id: b.id, title: b.label })
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
}
