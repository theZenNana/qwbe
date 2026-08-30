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
 *   - `usesCubeMetadata`-- the cube receives the derived metadata of every mounted cube.
 */
export type { CubeMetadata } from "./schemas.ts"

export type MetadataDeclarations = {
  readonly version?: string
  readonly searchable?: readonly string[]
  readonly fields?: Readonly<Record<string, { readonly label?: string }>>
  readonly relations?: Readonly<Record<string, { readonly target: string }>>
  readonly usesCubeMetadata?: boolean
}
