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
}).annotations({ identifier: "FieldMetadata" })

export const CubeMetadata = Schema.Struct({
  cube: Schema.String,
  entity: Schema.NullOr(Schema.String),
  /** Declared by the cube (`Manifest.version`); clients cache metadata keyed by it. */
  version: Schema.NullOr(Schema.String),
  /** Fingerprint of the derived fields. Changes whenever the schema or declarations change. */
  schemaHash: Schema.String,
  fields: Schema.Array(FieldMetadata),
}).annotations({ identifier: "CubeMetadata" })

export type CubeMetadata = typeof CubeMetadata.Type
export type FieldMetadata = typeof FieldMetadata.Type

/** The meta columns every entity row carries (see `EntityMeta`). */
