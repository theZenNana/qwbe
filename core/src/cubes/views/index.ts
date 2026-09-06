// The VIEWS cube -- saved list views as a platform feature (QWB-62, kernel stage).
//
// A saved view is an opaque query DESCRIPTION for some other cube's list screen: the
// `views` cube stores parameters and returns parameters. It never executes a list on
// behalf of the caller and never returns a row of any other cube. Applying a view is a
// client-side act: the client puts the parameters into its own request to the target
// cube, which is gated exactly as before. There is deliberately NO results route -- a
// shared view can never carry data, only shortcuts. probes/views.mjs checks the published
// OpenAPI has no such route, and greps this directory for imports of any other cube.
//
// Authorization is entirely the kernel's: `usesEntityPermissions` wraps every handler, so
// create claims ownership, item routes authorize read/edit/delete, and the list route is
// filtered row by row. This file contains no permission code and imports nothing from any
// other cube (the same decoupling as notes: look for "crm" here -- it is not anywhere).
//
// ponytail: the enforced list wrapper scans the whole `views` table per list call,
// inherited from entity-enforcement; an owner-indexed read needs a kernel primitive.
// ponytail: duplicate view names are allowed -- the store contract has no unique index,
// same reasoning as permissions/capabilities.ts.
//
// The row carries no `ownerId`: the permissions service's ownership record is the single
// authority, so nothing denormalized can go stale after a transfer (checked live by
// probes/views.mjs: after a transfer the old owner loses access, with no rewrite).
// `updatedBy` is provenance of the last edit, never authority.
//
// Cube admins and the superadmin can read every user's saved views, including the filter
// values typed into them. That is the platform's existing model (query text, never rows).

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization, CurrentUser, requirePermission } from "qwbe-core/auth"
import { type CubeTools, defineCube } from "qwbe-core/cube"
import { EntityMeta } from "qwbe-core/entity"
import { Forbidden, NotFound } from "qwbe-core/errors"
import { PageOf } from "qwbe-core/http"
import { PageParams, pageRequest } from "qwbe-core/pagination"
import { encodeTargetCube, encodeViewConfig, encodeViewName } from "./view-config.ts"

const TABLE = "views"
const ENTITY = "SavedView"

const ROUTES = {
  list: "views:read",
  get: "views:read",
  create: "views:write",
  update: "views:write",
  remove: "views:write",
} as const

const SORTABLE = ["name", "createdAt", "updatedAt"] as const

const SavedView = Schema.Struct({
  ...EntityMeta,
  /** Which cube's list this view describes. An opaque label here, never dereferenced. */
  targetCube: Schema.String,
  name: Schema.String,
  /** The validated, re-encoded JSON document -- never the raw bytes the client sent. */
  config: Schema.String,
  updatedAt: Schema.String,
  /** Who made the last edit. Provenance only -- never authority over the row. */
  updatedBy: Schema.String,
}).annotations({ identifier: "SavedView" })

const ViewCreate = Schema.Struct({
  targetCube: Schema.String,
  name: Schema.String,
  config: Schema.Unknown,
}).annotations({ identifier: "ViewCreate" })

/**
 * `targetCube` is immutable on purpose: it is not in this payload, and the decode rejects
 * unknown keys, so "move this view to another cube" is a 400, not a silent rewrite.
 */
const ViewPatch = Schema.Struct({
  name: Schema.optional(Schema.String),
  config: Schema.optional(Schema.Unknown),
}).annotations({ identifier: "ViewPatch" })

const ViewListParams = Schema.Struct({
  ...PageParams.fields,
  targetCube: Schema.optional(Schema.String),
})

const group = HttpApiGroup.make("views")
  .add(
    HttpApiEndpoint.get("list")`/views`.setUrlParams(ViewListParams).addSuccess(PageOf(SavedView)).addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.get("get")`/views/${HttpApiSchema.param("id", Schema.String)}`
      .addSuccess(SavedView)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .add(HttpApiEndpoint.post("create")`/views`.setPayload(ViewCreate).addSuccess(SavedView).addError(Forbidden))
  .add(
    HttpApiEndpoint.patch("update")`/views/${HttpApiSchema.param("id", Schema.String)}`
      .setPayload(ViewPatch)
      .addSuccess(SavedView)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.del("remove")`/views/${HttpApiSchema.param("id", Schema.String)}`
      .addSuccess(SavedView)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .middleware(Authorization)

type SavedViewRow = typeof SavedView.Type
type ViewListParamsType = typeof ViewListParams.Type

export const cube = defineCube(group, {
  manifest: {
    name: "views",
    version: "1.0.0",
    tables: [TABLE],
    entity: ENTITY,
    sortable: SORTABLE,
    requiresAuth: true,
    // Owner decision (QWB-62): an ordinary reader creates their OWN views. The entity
    // wrapper still decides WHICH rows -- a reader sees only own + granted views.
    permissions: [
      { name: "views:read", roles: ["admin", "reader"] },
      { name: "views:write", roles: ["admin", "reader"] },
    ],
    routes: ROUTES,
    usesEntityPermissions: true,
  },

  create: ({ store }: CubeTools) => {
    return {
      handlers: {
        list: ({ urlParams }: { urlParams: ViewListParamsType }) =>
          Effect.gen(function* () {
            yield* requirePermission(ROUTES.list)
            const page = pageRequest(urlParams)
            const rows = (yield* store.all<SavedViewRow>(TABLE)).filter(
              (v) => !v.deleted && (urlParams.targetCube === undefined || v.targetCube === urlParams.targetCube),
            )
            const field = SORTABLE.includes(page.sortBy as (typeof SORTABLE)[number])
              ? (page.sortBy as string)
              : "createdAt"
            rows.sort((left, right) =>
              String(left[field as keyof SavedViewRow] ?? "").localeCompare(
                String(right[field as keyof SavedViewRow] ?? ""),
              ),
            )
            if (page.descending) rows.reverse()
            return {
              rows: rows.slice(page.offset, page.offset + page.limit),
              total: rows.length,
              offset: page.offset,
              limit: page.limit,
              sortedBy: field,
            }
          }),

        get: ({ path }: { path: { id: string } }) =>
          Effect.gen(function* () {
            yield* requirePermission(ROUTES.get)
            const v = yield* store.byId<SavedViewRow>(TABLE, path.id)
            if (!v || v.deleted) return yield* Effect.fail(new NotFound({ message: `view ${path.id} does not exist` }))
            // Read authorization is the wrapper's job (it ran before this handler).
            return v
          }),

        create: ({ payload }: { payload: typeof ViewCreate.Type }) =>
          Effect.gen(function* () {
            yield* requirePermission(ROUTES.create)
            const user = yield* CurrentUser
            const targetCube = encodeTargetCube(payload.targetCube)
            const name = encodeViewName(payload.name)
            const config = encodeViewConfig(payload.config)
            const now = new Date().toISOString()
            return (yield* store.insert(TABLE, ENTITY, "view", {
              targetCube,
              name,
              config,
              updatedAt: now,
              updatedBy: user.id,
            })) as SavedViewRow
          }),

        update: ({ path, payload }: { path: { id: string }; payload: typeof ViewPatch.Type }) =>
          Effect.gen(function* () {
            yield* requirePermission(ROUTES.update)
            const user = yield* CurrentUser
            const v = yield* store.byId<SavedViewRow>(TABLE, path.id)
            if (!v || v.deleted) return yield* Effect.fail(new NotFound({ message: `view ${path.id} does not exist` }))
            const patch: Record<string, unknown> = { updatedAt: new Date().toISOString(), updatedBy: user.id }
            if (payload.name !== undefined) patch.name = encodeViewName(payload.name)
            if (payload.config !== undefined) patch.config = encodeViewConfig(payload.config)
            const updated = yield* store.update(TABLE, path.id, patch)
            if (!updated) return yield* Effect.fail(new NotFound({ message: `view ${path.id} does not exist` }))
            return updated as SavedViewRow
          }),

        remove: ({ path }: { path: { id: string } }) =>
          Effect.gen(function* () {
            yield* requirePermission(ROUTES.remove)
            const v = yield* store.byId<SavedViewRow>(TABLE, path.id)
            if (!v || v.deleted) return yield* Effect.fail(new NotFound({ message: `view ${path.id} does not exist` }))
            const removed = yield* store.update(TABLE, path.id, { deleted: true })
            if (!removed) return yield* Effect.fail(new NotFound({ message: `view ${path.id} does not exist` }))
            return removed as SavedViewRow
          }),
      },
    }
  },
})
