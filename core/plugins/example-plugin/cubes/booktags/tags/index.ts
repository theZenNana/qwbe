// The second child of Booktags -- classifies its sibling's bookmarks.
//
// It does not know what a Bookmark is beyond the entity name in the space file: the link
// lives in `core/src/spaces/workspace/`, declared by neither side, exactly as when both were
// flat cubes. The hierarchy changes WHO OWNS them, not how they connect.

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Schema } from "effect"
import { type CubeTools, defineCube } from "qwbe-core/cube"
import { Authorization, requirePermission } from "../../../../../src/kernel/auth-contract.ts"
import { EntityMeta, type SummaryRow } from "../../../../../src/kernel/entity.ts"
import { Forbidden, NotFound } from "../../../../../src/kernel/errors.ts"
import { PageOf, PageParams, pageRequest } from "../../../../../src/kernel/pagination.ts"

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
  .add(
    HttpApiEndpoint.get("get")`/tags/${HttpApiSchema.param("id", Schema.String)}`
      .addSuccess(Tag)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .add(HttpApiEndpoint.post("create")`/tags`.setPayload(TagCreate).addSuccess(Tag).addError(Forbidden))
  .middleware(Authorization)

const summary = (t: TagRow): SummaryRow => ({
  id: t.id,
  title: t.label,
  details: [{ key: "bookmarkId", value: t.bookmarkId }],
})

export const cube = defineCube(group, {
  manifest: {
    name: "tags",
    parent: "booktags",
    tables: [TABLE],
    entity: ENTITY,
    sortable: ["label"],
    requiresAuth: true,
    permissions: [
      { name: "booktags/tags:read", roles: ["admin", "reader"] },
      { name: "booktags/tags:write", roles: ["admin"] },
    ],
    publishes: ["booktags/tags.created"],
  },

  create: ({ store, bus }: CubeTools) => ({
    handlers: {
      list: ({ urlParams }: { urlParams: typeof PageParams.Type }) =>
        Effect.gen(function* () {
          yield* requirePermission("booktags/tags:read")
          return yield* store.page<TagRow>(TABLE, pageRequest(urlParams))
        }),

      get: ({ path }: { path: { id: string } }) =>
        Effect.gen(function* () {
          yield* requirePermission("booktags/tags:read")
          const tag = yield* store.byId<TagRow>(TABLE, path.id)
          if (!tag) return yield* Effect.fail(new NotFound({ message: `tag ${path.id} does not exist` }))
          return tag
        }),

      create: ({ payload }: { payload: typeof TagCreate.Type }) =>
        Effect.gen(function* () {
          yield* requirePermission("booktags/tags:write")
          const t = (yield* store.insert(TABLE, ENTITY, "tag", payload)) as TagRow
          yield* bus.publish("booktags/tags.created", { id: t.id, title: t.label })
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
})
