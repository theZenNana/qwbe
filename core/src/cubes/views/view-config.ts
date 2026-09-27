// The trust boundary of the views cube.
//
// A saved view is a query DESCRIPTION typed in a browser, stored by the kernel, and read
// back by every recipient of a shared view. It is therefore validated at WRITE -- decoded
// with an exact Effect Schema (unknown top-level keys rejected), bounded, and re-encoded,
// so raw untrusted JSON is never stored.
//
// What this deliberately does NOT check: whether `columns`/`filters`/`sortBy` name fields
// that exist in the target cube. This cube imports nothing from any other cube (checked
// mechanically by `npm run boundaries`), and field existence changes over time anyway -- a
// custom field can be deleted the minute after the write. The other half of validation
// runs at APPLY time in the frontend, against the live published metadata of the target
// cube. Both halves are required; neither replaces the other.
//
// Two corrections to the original plan, by owner decision:
//   - Reserved query names (LIST_PARAMS) constrain FILTER KEYS only. A column or sortBy
//     named `q` or `sort` is a legitimate field name of some cube; a filter key named
//     `page` would be query syntax.
//   - There is no `ownerId` on the row: the permissions service's ownership record is the
//     only authority, so nothing can go stale after a transfer.

import { Effect, ParseResult, Schema } from "effect"
import { BadRequest } from "qwbe-core/errors"
import { LIST_PARAMS } from "../../metadata/declarations.ts"

const MAX_CONFIG_BYTES = 8192
const MAX_COLUMNS = 60
const MAX_FILTERS = 30
const MAX_TEXT = 200
/** `pageSize` is bounded by the kernel list cap -- a view can never ask past it. */
const MAX_PAGE_SIZE = 200
const MAX_NAME = 80

/** A field name: an identifier, not query syntax. Reserved names are allowed here. */
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

const RESERVED = new Set(LIST_PARAMS)

// Every limit is a schema filter; its failure string is the exact message the 400 carries.
const Columns = Schema.Array(Schema.String).pipe(
  Schema.filter((columns) => columns.length <= MAX_COLUMNS || `more than ${MAX_COLUMNS} columns`),
  Schema.filter((columns) => new Set(columns).size === columns.length || "duplicate column"),
  Schema.filter((columns) => {
    const bad = columns.find((column) => !FIELD.test(column))
    return bad === undefined || `column ${JSON.stringify(bad)} is not a field name`
  }),
)

const filterProblem = (key: string, value: string) =>
  !FIELD.test(key)
    ? `filter key ${JSON.stringify(key)} is not a field name`
    : RESERVED.has(key)
      ? `filter key ${JSON.stringify(key)} is a reserved query name`
      : value.length > MAX_TEXT
        ? `filter value for ${JSON.stringify(key)} over ${MAX_TEXT} chars`
        : undefined

const Filters = Schema.Record({ key: Schema.String, value: Schema.String }).pipe(
  Schema.filter((filters) => Object.keys(filters).length <= MAX_FILTERS || `more than ${MAX_FILTERS} filters`),
  Schema.filter((filters) => {
    for (const [key, value] of Object.entries(filters)) {
      const problem = filterProblem(key, value)
      if (problem) return problem
    }
    return true
  }),
)

/**
 * The shape a view's config may carry. Exact: the decode below rejects unknown keys, so a
 * future field arrives as a deliberate schema change, not as silent pass-through. Keys
 * mirror the published ListContract vocabulary.
 */
const ViewConfigSchema = Schema.Struct({
  columns: Schema.optional(Columns),
  filters: Schema.optional(Filters),
  q: Schema.optional(Schema.String.pipe(Schema.filter((q) => q.length <= MAX_TEXT || `q over ${MAX_TEXT} chars`))),
  sortBy: Schema.optional(Schema.String.pipe(Schema.filter((f) => FIELD.test(f) || "sortBy is not a field name"))),
  descending: Schema.optional(Schema.Boolean),
  pageSize: Schema.optional(
    Schema.Number.pipe(
      Schema.filter(
        (n) =>
          (Number.isInteger(n) && n >= 1 && n <= MAX_PAGE_SIZE) || `pageSize must be an integer 1..${MAX_PAGE_SIZE}`,
      ),
    ),
  ),
}).pipe(
  Schema.filter((config) => JSON.stringify(config).length <= MAX_CONFIG_BYTES || `over ${MAX_CONFIG_BYTES} bytes`),
)

export type ViewConfig = typeof ViewConfigSchema.Type

// A limit names itself; a shape error (wrong type, unknown key) is prefixed with its path.
const configMessage = (error: ParseResult.ParseError) => {
  const [first] = ParseResult.ArrayFormatter.formatErrorSync(error)
  if (!first) return "undecodable"
  return first._tag === "Refinement" ? first.message : `${first.path.join(".")} ${first.message}`.trim()
}

/** Decoded and re-encoded on every write; this function is the only path in. */
export const encodeViewConfig = (raw: unknown): Effect.Effect<string, BadRequest> =>
  Schema.decodeUnknown(ViewConfigSchema, { onExcessProperty: "error" })(raw).pipe(
    Effect.map((config) => JSON.stringify(config)),
    Effect.mapError((error) => new BadRequest({ message: `invalid view config: ${configMessage(error)}` })),
  )

export const encodeViewName = (raw: string): Effect.Effect<string, BadRequest> => {
  const name = raw.trim()
  return name.length < 1 || name.length > MAX_NAME
    ? Effect.fail(new BadRequest({ message: `invalid view name: 1..${MAX_NAME} chars after trim` }))
    : Effect.succeed(name)
}

/** An opaque label, never dereferenced by this cube. Bounded so it stays a label. */
export const encodeTargetCube = (raw: string): Effect.Effect<string, BadRequest> =>
  /^[A-Za-z0-9][A-Za-z0-9_/-]{0,119}$/.test(raw)
    ? Effect.succeed(raw)
    : Effect.fail(new BadRequest({ message: "invalid targetCube" }))
