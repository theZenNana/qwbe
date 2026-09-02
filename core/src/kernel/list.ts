// ONE list handler, generated from the manifest, for every cube that lists rows (QWB-54).
//
// What it replaces: the kernel published `searchable` in the metadata, a frontend built a filter
// box out of it and sent the value to the list route -- but `searchable` described the `/links`
// route only, and each cube's list handler decided by itself what to do with the query string.
// So organizations filtered by nothing and contacts filtered through a hand-written `accountId`.
// The published contract and the served contract were two different things that looked like one.
//
// Now the manifest is the whole answer, and both sides read it through the SAME two functions
// (`searchFields`, `filterFields` in metadata/declarations.ts): this module turns them into SQL,
// `metadata.ts` publishes them as the list contract. They cannot drift, because there is nothing
// to keep in step.
//
//     GET /<cube>?page=1&pageSize=50&sort=title:desc&q=ada&<field>=<value>&ids=a,b,c
//
// `page` is 1-based. `pageSize` is capped at MAX_LIMIT by `pageRequest`, which everything here
// goes through. The older `offset` / `limit` / `sortBy` / `descending` spelling still works and
// means the same thing: it is what every probe and today's frontend send, and renaming four
// parameters by breaking them would be a migration, not a feature.
//
// A cube writes its own list handler only for something the manifest cannot express -- `notes`
// does, because its list is filtered per row by entity permissions.

import { HttpServerRequest } from "@effect/platform"
import { Effect, Option, Schema } from "effect"
import type { MetadataDeclarations } from "../metadata/declarations.ts"
import { filterFields, searchFields } from "../metadata/declarations.ts"
import { declaredPermission, readPermissionOf, requirePermission } from "./auth-contract.ts"
import type { CubeStore } from "./manifest.ts"
import { DEFAULT_LIMIT, type ListWhere, MAX_LIMIT, type PageRequest, pageRequest, SortField } from "./pagination.ts"

/** `field` or `field:asc` or `field:desc`. Rejected in the schema, so a bad value is a 400 with
 *  a reason in the emitted OpenAPI -- not a silently ignored parameter. */
const SORT = /^[A-Za-z_][A-Za-z0-9_]*(:(asc|desc))?$/

/**
 * The fixed half of the list query. The `<field>=<value>` half is NOT declared here on purpose:
 * it differs per cube, and a Schema.Struct built per cube would make every list endpoint's type
 * depend on its manifest at compile time for a gain the metadata already delivers. The handler
 * reads those from the raw query string and accepts only the names `filterFields` allows.
 */
export const ListParams = Schema.Struct({
  // The older four, WITHOUT the defaults `PageParams` gives them. A default would make
  // "the caller asked for 25" and "the caller said nothing" the same value, and the rules
  // below (the `ids=` batch size, and the entity-permission wrapper driving this handler
  // with an offset of its own) both need to tell those apart.
  offset: Schema.optional(Schema.NumberFromString),
  limit: Schema.optional(Schema.NumberFromString),
  sortBy: Schema.optional(SortField),
  descending: Schema.optional(Schema.BooleanFromString),
  page: Schema.optional(Schema.NumberFromString),
  pageSize: Schema.optional(Schema.NumberFromString),
  sort: Schema.optional(
    Schema.String.pipe(Schema.pattern(SORT, { message: () => "sort must be `field`, `field:asc` or `field:desc`" })),
  ),
  q: Schema.optional(Schema.String),
  ids: Schema.optional(Schema.String),
})

export type ListParamsType = typeof ListParams.Type

/** The query string as plain strings. Empty when no request is in context -- a command, a test. */
export const rawQuery: Effect.Effect<Record<string, string>, never, never> = Effect.map(
  Effect.serviceOption(HttpServerRequest.HttpServerRequest),
  Option.match({
    onNone: (): Record<string, string> => ({}),
    onSome: (request) => {
      const mark = request.url.indexOf("?")
      if (mark < 0) return {}
      const out: Record<string, string> = {}
      for (const [key, value] of new URLSearchParams(request.url.slice(mark + 1))) out[key] = value
      return out
    },
  }),
)

const idsOf = (raw: string | undefined): ReadonlyArray<string> =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

/** Page, size and ordering, from either spelling. */
export const listPageRequest = (p: ListParamsType): PageRequest => {
  const ids = idsOf(p.ids)
  const sizeAsked = p.pageSize !== undefined || p.limit !== undefined
  // `ids=` is a batch, not a page: unless a size was asked for, the batch IS the size, so
  // `?ids=a,b,c` returns exactly those rows in one request instead of the first 25 of them.
  const limit = sizeAsked
    ? (p.pageSize ?? p.limit ?? DEFAULT_LIMIT)
    : ids.length > 0
      ? Math.min(MAX_LIMIT, ids.length)
      : DEFAULT_LIMIT
  const [field, direction] = (p.sort ?? "").split(":")
  const sortBy = field !== undefined && field !== "" ? field : p.sortBy
  // `page` goes through uninterpreted: pageRequest derives the offset from the CAPPED limit,
  // the only place that knows the cap -- deriving it here would resurrect the lost rows.
  return pageRequest({
    page: p.page,
    offset: p.offset,
    limit,
    ...(sortBy === undefined ? {} : { sortBy }),
    descending: p.sort !== undefined ? direction === "desc" : (p.descending ?? false),
  })
}

/** The filters, from the manifest and the query string. `undefined` when nothing was asked. */
export const listWhere = (
  p: ListParamsType,
  raw: Record<string, string>,
  manifest: MetadataDeclarations,
): ListWhere | undefined => {
  const equals = filterFields(manifest).flatMap((field) =>
    typeof raw[field] === "string" && raw[field] !== "" ? [{ field, value: raw[field] }] : [],
  )
  const ids = idsOf(p.ids)
  const text = (p.q ?? "").trim()
  const fields = searchFields(manifest)
  const q = text !== "" && fields.length > 0 ? { text, fields } : undefined
  if (equals.length === 0 && ids.length === 0 && q === undefined) return undefined
  return { equals, ids, ...(q ? { q } : {}) }
}

export type GenericList<A, B> = {
  /** The cube's FULL name. The list requires the manifest's declared `routes.list`, falling
   *  back to `<name>:read` -- the convention every cube follows (see `readPermissionOf`). */
  readonly cube: string
  readonly table: string
  /** The cube's own manifest. `name` is in the type only to keep TypeScript's weak-type check
   *  useful: every declaration in `MetadataDeclarations` is optional, so without one required
   *  property any object at all would satisfy this parameter. */
  readonly manifest: MetadataDeclarations & { readonly name: string }
  readonly store: CubeStore
  /** Shape a stored row into what the contract publishes. Omitted means publish it as stored. */
  readonly map?: (row: A) => B
  /** Run before the query. `account` seeds its first user here; nothing else needs it. */
  readonly before?: Effect.Effect<unknown, never, never>
}

/** The handler itself. A cube's `list` becomes one line: `list: genericList({...})`. */
export const genericList =
  <A, B = A>(config: GenericList<A, B>) =>
  ({ urlParams }: { urlParams: ListParamsType }) =>
    Effect.gen(function* () {
      // The ONE derivation (QWB-54, 14c): the same `declaredPermission` the metadata publishes
      // through. `??` is only for the type -- `validateRoutes` refuses `list: null` at mount.
      yield* requirePermission(
        declaredPermission(config.manifest.routes, config.cube, "list") ?? readPermissionOf(config.cube),
      )
      if (config.before) yield* config.before
      const raw = yield* rawQuery
      const page = yield* config.store.page<A>(
        config.table,
        listPageRequest(urlParams),
        listWhere(urlParams, raw, config.manifest),
      )
      const map = config.map
      return {
        rows: map ? page.rows.map(map) : (page.rows as unknown as ReadonlyArray<B>),
        total: page.total,
        offset: page.offset,
        limit: page.limit,
        sortedBy: page.sortedBy,
      }
    })
