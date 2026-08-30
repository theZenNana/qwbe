// Per-cube field metadata, DERIVED from the cube's real contract.
//
// An external frontend must build lists, forms and detail views from metadata instead of
// hand-written shapes. The single source of truth stays the cube's Effect schema (its
// HttpApiGroup) and its manifest: this module only READS them. A hand-written field list
// copied anywhere would drift from the schema it describes -- so there is none.
//
// Where the schema alone cannot answer a question, the manifest may declare it, optionally
// and well-typed (see `Manifest.fields`, `Manifest.relations`, `Manifest.searchable`):
//
//   - a human label     -> `fields: { partyId: { label: "Party" } }`
//   - a relation target -> `relations: { partyId: { target: "crm/contacts" } }`
//
// Everything else has a default derived from the schema, so existing cubes keep working
// untouched: editable and required come from the create payload, sortable from the manifest's
// `sortable` list, searchable from the space links that actually reach the cube's search,
// enums from literal unions, nullability from the AST itself.

import { createHash } from "node:crypto"
import type { PropertySignature } from "effect/SchemaAST"
import { EntityMeta } from "../kernel/entity.ts"
import { classify, encodedLiteralOf, entityStructOf, groupEndpoints } from "./ast.ts"
import type { MetadataDeclarations } from "./declarations.ts"
import type { CubeMetadata, FieldMetadata } from "./schemas.ts"

export type { MetadataDeclarations } from "./declarations.ts"
export { CubeMetadata, FieldMetadata, RelationMetadata } from "./schemas.ts"

export type MetadataCube = {
  readonly name: string
  readonly manifest: MetadataDeclarations & {
    readonly entity?: string
    readonly sortable?: readonly string[]
  }
  readonly parts: {
    readonly group: unknown
    readonly relational?: { readonly summaryById?: unknown; readonly search?: unknown }
  }
}

type DeclaredManifest = MetadataCube["manifest"]

// The meta columns every entity row carries, taken from EntityMeta itself -- a second
// hand-written copy of that list is exactly the drift this module exists to prevent.
const META_FIELDS = new Set(Object.keys(EntityMeta))
// Sortable defaults to the meta columns a caller may order by; `deleted` is a filter, not an
// ordering, so it stays out -- but it is still derived, not re-typed.
const SORTABLE_DEFAULT = Object.keys(EntityMeta).filter((name) => name !== "deleted")

const humanize = (name: string): string => {
  const spaced = name.replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** Metadata for every mounted cube that publishes a field list. Pure, so callers may recompute. */
export const deriveAllMetadata = (
  cubes: ReadonlyArray<MetadataCube>,
  links: ReadonlyArray<{ from: string; field: string; to: string }>,
): ReadonlyArray<CubeMetadata> =>
  cubes.map((c) => deriveCubeMetadata(c, cubes, links)).filter((m): m is CubeMetadata => m !== undefined)

/**
 * Derive the metadata of one mounted cube, given ALL mounted cubes (to resolve relation
 * targets) and the live space links. Returns undefined when the cube holds no entity schema
 * in its contract -- a cube without rows has no field metadata to publish.
 */
export const deriveCubeMetadata = (
  cube: MetadataCube,
  cubes: ReadonlyArray<MetadataCube>,
  links: ReadonlyArray<{ from: string; field: string; to: string }>,
): CubeMetadata | undefined => {
  const struct = entityStructOf(cube.parts.group)
  if (!struct) return undefined
  const m: DeclaredManifest = cube.manifest
  // `payloadSchema` is an Option -- unwrap it before reading its AST.
  const rawPayload = groupEndpoints(cube.parts.group).create?.payloadSchema
  const payload = encodedLiteralOf(
    rawPayload && (rawPayload as { _tag?: string })._tag === "Some"
      ? (rawPayload as { value: unknown }).value
      : undefined,
  )

  const firstPass = struct.propertySignatures.map((p: PropertySignature) => ({
    name: String(p.name),
    shape: classify(p.type),
  }))
  // A field is searchable only if a caller can actually search by it. The only search route
  // is GET /links/{entity}/{id}/{cube}, which looks up rows of THIS cube whose LINK FIELD
  // equals {id} -- so the usable fields are exactly the cube's declared space-link fields,
  // and only when the cube implements the exact-equality search those links resolve through.
  // Marking every text field searchable advertised a capability no route served.
  const searchableSet = new Set(
    m.searchable ??
      (cube.parts.relational?.search ? links.filter((l) => l.from === cube.name).map((l) => l.field) : []),
  )
  const sortableSet = new Set(m.sortable ?? SORTABLE_DEFAULT)

  const fields: ReadonlyArray<FieldMetadata> = firstPass.map(({ name, shape }) => {
    // Required/editable read the CREATE payload's ENCODED side: a field with a default
    // (`optionalWith`) is present-but-optional there -- editable, not required.
    const payloadProp = payload?.propertySignatures.find((p) => String(p.name) === name)
    const inPayload = payloadProp !== undefined
    const relation = resolveRelation(name, cube, cubes, links, m)
    return {
      name,
      label: m.fields?.[name]?.label ?? humanize(name),
      type: shape.type,
      required: payloadProp ? !payloadProp.isOptional : false,
      editable: inPayload,
      sortable: sortableSet.has(name),
      searchable: searchableSet.has(name),
      nullable: shape.nullable,
      enum: shape.enum ? [...shape.enum] : null,
      relation,
    }
  })

  return {
    cube: cube.name,
    entity: m.entity ?? null,
    version: m.version ?? null,
    schemaHash: createHash("sha256")
      .update(JSON.stringify({ cube: cube.name, entity: m.entity ?? null, fields }))
      .digest("hex"),
    fields,
  }
}

/**
 * Where a field points, and how a summary for the other side resolves.
 *
 * Two declared sources, in order: the cube's own `relations` (a field the cube KNOWS points
 * somewhere, e.g. `partyId`), then a space link (declared by a third party). The summary is
 * never invented here: it is "summaryById" exactly when the target cube implements
 * `summaryById` -- the mechanism that already exists is the one that is published.
 */
const resolveRelation = (
  field: string,
  cube: MetadataCube,
  cubes: ReadonlyArray<MetadataCube>,
  links: ReadonlyArray<{ from: string; field: string; to: string }>,
  m: DeclaredManifest,
): { target: string; entity: string; summary: string | null } | null => {
  const declaredTarget = m.relations?.[field]?.target
  const spaceLink = links.find((l) => l.from === cube.name && l.field === field)
  const target = declaredTarget
    ? cubes.find((c) => c.name === declaredTarget)
    : spaceLink
      ? cubes.find((c) => c.manifest.entity === spaceLink.to)
      : undefined
  if (!target) return null
  return {
    target: target.name,
    entity: target.manifest.entity ?? target.name,
    summary: target.parts.relational?.summaryById ? "summaryById" : null,
  }
}
