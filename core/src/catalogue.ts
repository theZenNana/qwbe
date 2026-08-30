import type { Effect } from "effect"
import { deriveAllMetadata, type MetadataCube, metadataHash } from "./metadata/metadata.ts"
import type { CubeMetadata, FieldMetadata } from "./metadata/schemas.ts"

export type Catalogue = ReadonlyArray<{
  readonly name: string
  readonly parent?: string | undefined
  readonly entity?: string | undefined
  readonly screen: boolean
  readonly agent: boolean
  readonly entityPermissions: boolean
  readonly enabled: boolean
  readonly required: boolean
  readonly system: boolean
  readonly plugin: string | null
  readonly prefix?: string | undefined
  readonly publishes: ReadonlyArray<string>
  readonly sortable: ReadonlyArray<string>
  readonly links: ReadonlyArray<{ readonly to: string; readonly field: string; readonly label: string }>
  /** Derived field metadata; absent for cubes whose contract holds no entity schema. */
  readonly metadata?: import("./metadata/metadata.ts").CubeMetadata | undefined
}>

type CatalogueDefinition = Readonly<{
  name: string
  plugin: string | null
  manifest: Readonly<{
    parent?: string
    entity?: string
    screen?: boolean
    agent?: boolean
    usesEntityPermissions?: boolean
    required?: boolean
    publishes?: ReadonlyArray<string>
    sortable?: ReadonlyArray<string>
  }>
  /** The mounted cube, when it is already created: carries the contract the metadata is
   *  derived from. Absent while mount is still walking the definitions. Structural on
   *  purpose -- importing the kernel back from here would close a dependency cycle. */
  cube?:
    | {
        readonly name: string
        readonly parts: { readonly group: unknown }
      }
    | undefined
}>

// --- custom fields (QWB-46) ---
//
// Custom-field VALUES live in the target row's `custom` sub-object; DEFINITIONS live in the
// cube that provides them. The kernel never knew about definitions before this ticket: they
// are runtime data, so they cannot be derived from a contract. A cube whose manifest declares
// `providesCustomFields` registers a provider here (through the `customFields` tool the kernel
// hands it at mount), and everything the kernel publishes about fields -- this catalogue's
// metadata -- appends the provider's active definitions, marked `custom: true`.

/** A subscription to an event, by string name. See `bus.ts`. */
export type Subscription = {
  readonly event: string
  readonly handle: (payload: unknown) => Effect.Effect<void, never, never>
}

/** One active custom-field definition, as the providing cube reports it. */
export type CustomFieldDefinition = {
  readonly name: string
  readonly label: string
  readonly fieldType: "text" | "number" | "date" | "bool" | "select"
  readonly required: boolean
  readonly options: ReadonlyArray<string>
  readonly position: number
}

export type CustomFieldProvider = (cube: string) => ReadonlyArray<CustomFieldDefinition>

const customFieldProviders: Array<CustomFieldProvider> = []

/**
 * The narrow tool the kernel lends a cube declaring `providesCustomFields` (QWB-46).
 *
 * `register` publishes the cube's ACTIVE definitions per target cube; the catalogue's metadata
 * appends them marked `custom: true`, and a frontend can tell them apart from static fields.
 * `rows` reads a target cube's rows so the provider can report ORPHANED values -- values still
 * sitting in a row's `custom` sub-object whose definition was deleted. Values are never handed
 * over for writing: they are written through the target cube's own API and store, nowhere else.
 */
export type CustomFieldTools = {
  readonly register: (provide: (cube: string) => ReadonlyArray<CustomFieldDefinition>) => void
  readonly rows: (
    cube: string,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly id: string; readonly custom: Record<string, unknown>; readonly deleted: boolean }>,
    never,
    never
  >
}

/** Called by the kernel at mount, once per cube declaring `providesCustomFields`. */
export const registerCustomFieldProvider = (provider: CustomFieldProvider): void => {
  customFieldProviders.push(provider)
}

/** The active custom-field definitions registered for a target cube. Pure read. */
export const activeCustomFields = (cube: string): ReadonlyArray<CustomFieldDefinition> =>
  customFieldProviders.flatMap((provider) => provider(cube))

/** A custom field's definition type, in the vocabulary the published metadata speaks. */
const customFieldType: Record<CustomFieldDefinition["fieldType"], string> = {
  text: "string",
  number: "number",
  date: "string",
  bool: "boolean",
  select: "string",
}

const customFieldMetadata = (d: CustomFieldDefinition): FieldMetadata => ({
  name: d.name,
  label: d.label,
  type: customFieldType[d.fieldType],
  required: d.required,
  editable: true,
  sortable: false,
  searchable: false,
  nullable: false,
  enum: d.fieldType === "select" ? [...d.options] : null,
  relation: null,
  custom: true,
})

/**
 * Append the target cube's active custom fields to its derived metadata, and re-fingerprint.
 *
 * Appended HERE, not inside the cached derivation: definitions are runtime data that change
 * without a remount, and the cache is keyed by the cube's mounted parts. The fingerprint covers
 * the enriched list -- a client caching by `schemaHash` re-fetches when an administrator defines
 * or deletes a field. The drift gate (schema-drift.ts) deliberately compares the STATIC hash:
 * runtime definitions are data, not a schema change under a declared version.
 */
const enrichWithCustomFields = (base: CubeMetadata | undefined, cube: string): CubeMetadata | undefined => {
  if (!base) return undefined
  const taken = new Set(base.fields.map((f) => f.name))
  const custom = activeCustomFields(cube).filter((d) => {
    // Review fix 9 (QWB-46) backstop: a definition named like a declared field can never hold
    // a value (the fold never touches declared keys), so publishing it would be a lie. The
    // `define` handler refuses the collision; this drops any that slipped through earlier.
    return !taken.has(d.name)
  })
  if (custom.length === 0) return base
  const fields = [...base.fields, ...custom.map(customFieldMetadata)]
  return { ...base, fields, schemaHash: metadataHash(base.cube, base.entity, base.version, fields) }
}

// Derived metadata is pure, and a mounted cube's contract never changes within one mount --
// so each cube is derived once and remembered by its parts object, not by name (two mounts
// in one process must not share a cache entry). The ABSENT result is cached too: most cubes
// hold no entity schema, and re-walking the ASTs for a cube that can never have metadata is
// the same waste as re-walking one that can.
const metadataCache = new WeakMap<object, CubeMetadata | null>()

// Counted for tests only: proves the derivation runs once per distinct set of mounted cubes,
// not once per cube and not once per catalogue() call.
export const metadataDerivations = { count: 0 }

/** Derive (or fetch from the cache) the metadata of every mounted cube. Shared with boot. */
export const catalogueMetadata = (
  cubes: ReadonlyArray<MetadataCube>,
  links: ReadonlyArray<{ from: string; to: string; field: string }>,
  isEnabled?: (name: string) => boolean,
): ReadonlyArray<CubeMetadata> => {
  if (cubes.some((c) => !metadataCache.has(c.parts))) {
    metadataDerivations.count += 1
    const derived = new Map(deriveAllMetadata(cubes, links, isEnabled).map((m) => [m.cube, m]))
    for (const c of cubes) if (!metadataCache.has(c.parts)) metadataCache.set(c.parts, derived.get(c.name) ?? null)
  }
  return cubes.flatMap((c) => {
    const cached = metadataCache.get(c.parts)
    return cached ? [cached] : []
  })
}

export const buildCatalogue = (
  definitions: ReadonlyArray<CatalogueDefinition>,
  enabled: (name: string) => boolean,
  prefix: (path: string) => string | undefined,
  links: ReadonlyArray<{ from: string; to: string; field: string; label: string }>,
): Catalogue => {
  const mountedCubes = definitions.flatMap((d) =>
    d.cube ? [{ name: d.name, manifest: d.manifest, parts: d.cube.parts }] : [],
  )
  const metadataByName = new Map(catalogueMetadata(mountedCubes, links, enabled).map((m) => [m.cube, m]))
  return definitions.map(({ name, plugin, manifest, cube }) => {
    const endpoints = (cube?.parts.group as { endpoints?: Record<string, { path?: string }> } | undefined)?.endpoints
    const firstPath = Object.values(endpoints ?? {})[0]?.path
    const metadata = cube ? enrichWithCustomFields(metadataByName.get(name), name) : undefined
    return {
      name,
      parent: manifest.parent,
      entity: manifest.entity,
      screen: manifest.screen === true,
      agent: manifest.agent === true,
      entityPermissions: manifest.usesEntityPermissions === true,
      enabled: enabled(name),
      required: manifest.required === true,
      system: plugin === null,
      plugin,
      prefix: firstPath ? prefix(firstPath) : undefined,
      publishes: manifest.publishes ?? [],
      sortable: manifest.sortable ?? [],
      links: links.filter((link) => link.from === name).map(({ to, field, label }) => ({ to, field, label })),
      metadata,
    }
  })
}
