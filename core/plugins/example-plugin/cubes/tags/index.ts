// The second cube of the example plugin.
//
// It exists because QWB-14 needs the example to be what real plugins are: MORE THAN ONE cube in
// one plugin, and a connection between its own cubes declared by neither - the link lives in
// `core/src/spaces/workspace/`, like every other relation. A tag points at the bookmark it
// labels; `bookmarks` does not know tags exist, and this cube does not know what a Bookmark is
// beyond the entity name in the space file.
//
// Same rules as the sibling: own database file, permissions aggregated into `auth`, real CRUD
// over HTTP.

import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization, requirePermission } from "../../../../src/kernel/auth-contract.ts"
import { EntityMeta, type SummaryRow } from "../../../../src/kernel/entity.ts"
import { Forbidden } from "../../../../src/kernel/errors.ts"
import type { CubeDefinition, CubeTools } from "../../../../src/kernel/manifest.ts"
import { PageOf, PageParams, pageRequest } from "../../../../src/kernel/pagination.ts"

const TABLE = "tags"
const ENTITY = "Tag"

const Tag = Schema.Struct({
  ...EntityMeta,
  label: Schema.String,
  /** The bookmark this tag labels. A plain foreign id - the relation is declared in the space. */
  bookmarkId: Schema.String,
}).annotations({ identifier: "Tag" })

const TagCreate = Schema.Struct({
  label: Schema.String,
  bookmarkId: Schema.String,
}).annotations({ identifier: "TagCreate" })

type TagRow = typeof Tag.Type

const group = HttpApiGroup.make("tags")
  .add(HttpApiEndpoint.get("list")`/tags`.setUrlParams(PageParams).addSuccess(PageOf(Tag)).addError(Forbidden))
  .add(HttpApiEndpoint.post("create")`/tags`.setPayload(TagCreate).addSuccess(Tag).addError(Forbidden))
  .middleware(Authorization)

const summary = (t: TagRow): SummaryRow => ({
  id: t.id,
  title: t.label,
  details: [{ key: "bookmarkId", value: t.bookmarkId }],
})

export const cube: CubeDefinition = {
  manifest: {
    name: "tags",
    tables: [TABLE],
    entity: ENTITY,
    sortable: ["label"],
    requiresAuth: true,
    permissions: [
      { name: "tags:read", roles: ["admin", "reader"] },
      { name: "tags:write", roles: ["admin"] },
    ],
    publishes: ["tags.created"],
  },

  create: ({ store, bus }: CubeTools) => ({
    group,

    handlers: {
      list: ({ urlParams }: { urlParams: typeof PageParams.Type }) =>
        Effect.gen(function* () {
          yield* requirePermission("tags:read")
          return yield* store.page<TagRow>(TABLE, pageRequest(urlParams))
        }),

      create: ({ payload }: { payload: typeof TagCreate.Type }) =>
        Effect.gen(function* () {
          yield* requirePermission("tags:write")
          const t = (yield* store.insert(TABLE, ENTITY, "tag", payload)) as TagRow
          yield* bus.publish("tags.created", { id: t.id, title: t.label })
          return t
        }),
    },

    relational: {
      search: (field, value, page) =>
        Effect.gen(function* () {
          const p = yield* store.page<TagRow>(TABLE, page, { field, value })
          return { rows: p.rows.map(summary), total: p.total }
        }),
      summaryById: (id) =>
        Effect.gen(function* () {
          const t = yield* store.byId<TagRow>(TABLE, id)
          return t ? summary(t) : undefined
        }),
    },
  }),
}
