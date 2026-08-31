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

export type MetadataDeclarations = {
  readonly version?: string
  readonly searchable?: readonly string[]
  readonly fields?: Readonly<Record<string, { readonly label?: string }>>
  readonly relations?: Readonly<Record<string, { readonly target: string }>>
}

// --- QWB-54: the same two functions answer "what may a caller filter by" for BOTH the served
// list (kernel/list.ts) and the published metadata (metadata.ts). They live here, next to the
// declarations they read, precisely so the two answers cannot drift apart -- which is what the
// ticket is about: `searchable` used to describe the /links route while every cube's list
// handler decided the query string on its own.

/** A field name that can be an SQL identifier or a jsonb key without quoting games. */
const SAFE_FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Parameter names the list contract owns; a field of the same name could not be filtered on. */
const RESERVED = new Set(["offset", "limit", "sortBy", "descending", "page", "pageSize", "sort", "q", "ids"])

/** What `q=` scans: exactly the fields the cube declares searchable. */
export const searchFields = (m: MetadataDeclarations): ReadonlyArray<string> =>
  (m.searchable ?? []).filter((f) => SAFE_FIELD.test(f) && !RESERVED.has(f))

/** What `<field>=<value>` accepts: the searchable fields plus every declared relation. A
 *  relation field is filterable by construction -- that is what a relation IS in a list. */
export const filterFields = (m: MetadataDeclarations): ReadonlyArray<string> =>
  [...new Set([...searchFields(m), ...Object.keys(m.relations ?? {})])]
    .filter((f) => SAFE_FIELD.test(f) && !RESERVED.has(f))
    .sort()
