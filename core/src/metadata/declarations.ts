// What a cube may DECLARE about its fields, on top of what its schema already says.
//
// These live with the metadata they feed, not in the kernel: the kernel's manifest type
// intersects them, and the per-cube field metadata (see `metadata.ts`) reads them. Every
// question the schema alone cannot answer has a default derived from the schema, so a cube
// declares only what it must.

/**
 * Optional per-cube manifest declarations:
 *
 *   - `version`         -- published in the metadata; declaring it opts the cube into the
 *                          drift gate (`schema-drift.ts`).
 *   - `searchable`      -- fields callers may search by.
 *   - `fields`          -- human labels, where the schema cannot name one.
 *   - `relations`       -- fields holding another cube's id, with the target cube.
 */

import { Schema } from "effect"
import { SortField } from "../kernel/pagination.ts"

export type MetadataDeclarations = {
  readonly version?: string
  readonly searchable?: readonly string[]
  readonly fields?: Readonly<Record<string, { readonly label?: string }>>
  readonly relations?: Readonly<Record<string, { readonly target: string }>>
  /**
   * The permission each of this cube's own routes requires, by ENDPOINT NAME (`list`,
   * `create`, ...). The declaration IS the enforcement: the mount wrapper in
   * `runtime-composition.ts` requires exactly what an entry declares before the handler runs,
   * and the metadata publishes the same derivation -- so a handler that forgets
   * `requirePermission` is still a 403, and renaming a permission in the kernel moves
   * enforcement, publication and the frontend together.
   *
   * `null` is the EXPLICIT opt-out: the requirement is decided per request in the handler
   * (the target cube's own read permission, a session-level logout). A mutating endpoint
   * behind Authorization with NO entry here is refused at boot (`validateRoutes`), so
   * "forgotten" is not a state the kernel can be in; `list` may not opt out at all -- the
   * kernel's read convention applies.
   *
   * The mount gate (`validateRoutes`) also refuses a name that is not an endpoint of this
   * cube or a permission this cube does not declare.
   */
  readonly routes?: Readonly<Record<string, string | null>>
}

// --- The same two functions answer "what may a caller filter by" for BOTH the served
// list (kernel/list.ts) and the published metadata (metadata.ts). They live here, next to the
// declarations they read, precisely so the two answers cannot drift apart.

/** A field name that can be an SQL identifier or a jsonb key without quoting games. */
const SAFE_FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/

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

export const LIST_PARAMS = Object.keys(ListParams.fields)

/** Parameter names the list contract owns; a field of the same name could not be filtered on. */
const RESERVED = new Set(LIST_PARAMS)

/** What `q=` scans: exactly the fields the cube declares searchable. */
export const searchFields = (m: MetadataDeclarations): ReadonlyArray<string> =>
  (m.searchable ?? []).filter((f) => SAFE_FIELD.test(f) && !RESERVED.has(f))

/** What `<field>=<value>` accepts: the searchable fields plus every declared relation. A
 *  relation field is filterable by construction -- that is what a relation IS in a list. */
export const filterFields = (m: MetadataDeclarations): ReadonlyArray<string> =>
  [...new Set([...searchFields(m), ...Object.keys(m.relations ?? {})])]
    .filter((f) => SAFE_FIELD.test(f) && !RESERVED.has(f))
    .sort()
