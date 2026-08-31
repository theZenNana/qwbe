// The staging cube's HTTP contracts. Everything the API publishes about a set, declared once
// here so the OpenAPI document and the handlers cannot disagree.

import { Schema } from "effect"

/**
 * The permission each route requires, declared ONCE (QWB-54, ticket 10): the manifest
 * publishes this object through the kernel's metadata and the handlers in handlers.ts check
 * through the same names, so renaming a permission moves enforcement and publication
 * together.
 */
export const ROUTES = {
  createSet: "staging:write",
  listSets: "staging:read",
  getSet: "staging:read",
  chunk: "staging:write",
  finish: "staging:write",
  sensitive: "staging:write",
  profile: "staging:read",
  deleteSet: "staging:write",
} as const

/** The two import formats. A set is ONE file's worth of rows, so the format is per set. */
export const StagingFormat = Schema.Literal("jsonl", "csv").annotations({ identifier: "StagingFormat" })

/** A set: one imported source file, its progress and its import tallies. */
export const StagingSet = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  format: StagingFormat,
  sourceFile: Schema.String,
  /** importing -> done | failed. `done` is set by the finish call, `failed` by a batch error. */
  state: Schema.Literal("importing", "done", "failed"),
  rowCount: Schema.Number,
  malformedCount: Schema.Number,
  malformedSample: Schema.Array(Schema.Struct({ line: Schema.Number, reason: Schema.String })),
  sensitiveFields: Schema.Array(Schema.String),
  createdAt: Schema.String,
}).annotations({ identifier: "StagingSet" })

export const SetCreate = Schema.Struct({
  name: Schema.String,
  format: StagingFormat,
  sourceFile: Schema.optionalWith(Schema.String, { default: () => "" }),
  /** Fields named here never return example values -- only counts. Changeable later. */
  sensitiveFields: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
}).annotations({ identifier: "SetCreate" })

/** One batch of raw text, parsed SERVER side so malformed lines are counted where the rows land.
 *
 * CONTRACT: a chunk must end on a LINE BOUNDARY. A client that splits by byte size will get
 * two spurious "invalid JSON" (or wrong-column) entries at wrong line numbers and two silently
 * lost records -- splitting mid-line is a client bug, stated here so the refusal is documented
 * rather than mysterious (QWB-45 review, item 19).
 *
 * The text is capped: one request may not hold a whole file in JS, expand to thousands of
 * INSERT statements and pin a pool connection for the length of the batch -- split the file
 * into more chunks instead (QWB-45 review, item 6). */
export const MAX_CHUNK_CHARS = 2_000_000

export const ChunkPayload = Schema.Struct({
  text: Schema.String.pipe(Schema.maxLength(MAX_CHUNK_CHARS)),
  /** Absolute line number of this chunk's first line, so malformed lines report file lines. */
  startLine: Schema.optionalWith(Schema.Number, { default: () => 1 }),
}).annotations({ identifier: "ChunkPayload" })

export const MalformedLine = Schema.Struct({ line: Schema.Number, reason: Schema.String }).annotations({
  identifier: "MalformedLine",
})

export const ChunkResult = Schema.Struct({
  parsed: Schema.Number,
  malformed: Schema.Array(MalformedLine),
}).annotations({ identifier: "ChunkResult" })

export const SetFinished = Schema.Struct({ id: Schema.String, state: Schema.String }).annotations({
  identifier: "SetFinished",
})

export const SensitivePayload = Schema.Struct({ fields: Schema.Array(Schema.String) }).annotations({
  identifier: "SensitivePayload",
})

export const SensitiveResult = Schema.Struct({
  id: Schema.String,
  sensitiveFields: Schema.Array(Schema.String),
}).annotations({ identifier: "SensitiveResult" })

export const Removed = Schema.Struct({ removed: Schema.String }).annotations({ identifier: "RemoveResult" })

export const ShapeCount = Schema.Struct({ shape: Schema.String, count: Schema.Number }).annotations({
  identifier: "ShapeCount",
})

export const ValueCount = Schema.Struct({ value: Schema.String, count: Schema.Number }).annotations({
  identifier: "ValueCount",
})

export const FieldProfile = Schema.Struct({
  field: Schema.String,
  filled: Schema.Number,
  fillRate: Schema.Number,
  distinct: Schema.Number,
  shapes: Schema.Array(ShapeCount),
  /** Absent for sensitive fields: counts only, never examples. */
  top: Schema.optional(Schema.Array(ValueCount)),
}).annotations({ identifier: "FieldProfile" })

export const Profile = Schema.Struct({
  setId: Schema.String,
  rows: Schema.Number,
  enumMax: Schema.Number,
  /** Present only when the set had more fields than the profile cap -- see profile-run.ts. */
  fieldsTruncated: Schema.optional(Schema.Boolean),
  fields: Schema.Array(FieldProfile),
}).annotations({ identifier: "Profile" })

/** The two tables staging owns. One source of names for the SQL the cube composes. */
export const TABLES = { sets: "sets", rows: "rows" } as const

// The type side of each schema: values at runtime, these at compile time. Same name on purpose.
export type StagingSet = typeof StagingSet.Type
export type MalformedLine = typeof MalformedLine.Type
export type FieldProfile = typeof FieldProfile.Type
export type ShapeCount = typeof ShapeCount.Type
export type ValueCount = typeof ValueCount.Type
