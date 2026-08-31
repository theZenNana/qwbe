// The published shape of the per-cube field metadata (also the OpenAPI schema of the
// metadata endpoint). See `metadata.ts` for how it is derived.

import { Schema } from "effect"

export const RelationMetadata = Schema.Struct({
  /** Cube holding the other side of the relation. */
  target: Schema.String,
  /** The entity on the other side, e.g. "Contact". */
  entity: Schema.String,
  /** How a summary for the target resolves, e.g. "summaryById". Null when none exists. */
  summary: Schema.NullOr(Schema.String),
}).annotations({ identifier: "RelationMetadata" })

export const FieldMetadata = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  /** string | integer | number | boolean | array | unknown */
  type: Schema.String,
  /** Must be provided when creating a row (from the create payload). */
  required: Schema.Boolean,
  /** Can be set by the caller on create (meta columns cannot). */
  editable: Schema.Boolean,
  sortable: Schema.Boolean,
  searchable: Schema.Boolean,
  nullable: Schema.Boolean,
  /** Literal options when the schema is a literal union, otherwise null. */
  enum: Schema.NullOr(Schema.Array(Schema.String)),
  relation: Schema.NullOr(RelationMetadata),
  /**
   * QWB-46: true when the field is a runtime-defined custom field, appended to the cube's
   * static schema by its custom-field provider. A frontend must be able to tell them apart:
   * a custom field has no code behind it -- it lives in the row's `custom` sub-object.
   */
  custom: Schema.Boolean,
}).annotations({ identifier: "FieldMetadata" })

/**
 * The list query contract, published so a frontend stops guessing it (QWB-54).
 *
 * Every value here is DERIVED from the same manifest declarations the kernel's generic list
 * handler reads, by the same two functions (`searchFields`, `filterFields`). What is published
 * and what is served are one thing, not two that have to be kept in step.
 */
export const ListContract = Schema.Struct({
  /** Accepted query parameters, in the spelling this contract owns. */
  params: Schema.Array(Schema.String),
  /**
   * How a page is addressed: "offset" today. It is the honest word for what the kernel does --
   * `page` becomes OFFSET/LIMIT -- and it is published so a frontend does not have to guess
   * whether it may jump to page 2400. Keyset paging, if it ever lands, arrives as another value
   * here rather than as a silent change of meaning.
   */
  paging: Schema.String,
  /**
   * True when `total` is an exact COUNT over the filtered set, which is what the kernel does
   * today: a paginator may show "page 12 of 240" and jump anywhere. An estimate would make that
   * a lie, so if the count ever becomes an estimate this turns false and the frontend can fall
   * back to "next / previous" without being told twice.
   */
  totalIsExact: Schema.Boolean,
  /** `pageSize` above this is clamped to it, never refused. */
  maxPageSize: Schema.Int,
  /** What `pageSize` is when the caller says nothing. */
  defaultPageSize: Schema.Int,
  /** Fields `q=` scans, as a prefix match, ORed together. */
  search: Schema.Array(Schema.String),
  /** Fields accepted as `<field>=<value>`, exact match. Relation fields are always among them. */
  filters: Schema.Array(Schema.String),
  /** Fields accepted as `sort=<field>` or `sort=<field>:desc`. */
  sort: Schema.Array(Schema.String),
}).annotations({ identifier: "ListContract" })

export const CubeMetadata = Schema.Struct({
  cube: Schema.String,
  entity: Schema.NullOr(Schema.String),
  /** What the cube's list route honours. Null when the cube publishes no list route. */
  list: Schema.NullOr(ListContract),
  /** Declared by the cube (`Manifest.version`); clients cache metadata keyed by it. */
  version: Schema.NullOr(Schema.String),
  /** Fingerprint of the derived fields. Changes whenever the schema or declarations change. */
  schemaHash: Schema.String,
  fields: Schema.Array(FieldMetadata),
}).annotations({ identifier: "CubeMetadata" })

export type CubeMetadata = typeof CubeMetadata.Type
export type FieldMetadata = typeof FieldMetadata.Type
