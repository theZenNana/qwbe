import { deriveAllMetadata, type MetadataCube } from "./metadata/metadata.ts"
import type { CubeMetadata } from "./metadata/schemas.ts"

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
    const metadata = cube ? metadataByName.get(name) : undefined
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
