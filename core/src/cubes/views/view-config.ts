// The trust boundary of the views cube.
//
// A saved view is a query DESCRIPTION typed in a browser, stored by the kernel, and read
// back by every recipient of a shared view. It is therefore validated at WRITE -- decoded
// with an exact Effect Schema (unknown top-level keys rejected), bounded, and re-encoded,
// so raw untrusted JSON is never stored.
//
// What this deliberately does NOT check: whether `columns`/`filters`/`sortBy` name fields
// that exist in the target cube. This cube imports nothing from any other cube (checked
// mechanically by probes/views.mjs), and field existence changes over time anyway -- a
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

import { Schema } from "effect"
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

/**
 * The shape a view's config may carry. Exact: the decode below rejects unknown keys, so a
 * future field arrives as a deliberate schema change, not as silent pass-through. Keys
 * mirror the published ListContract vocabulary; the values are bounded in code below,
 * where the error message can name the limit (schema refinements here would duplicate it).
 */
const ViewConfigSchema = Schema.Struct({
  columns: Schema.optional(Schema.Array(Schema.String)),
  filters: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  q: Schema.optional(Schema.String),
  sortBy: Schema.optional(Schema.String),
  descending: Schema.optional(Schema.Boolean),
  pageSize: Schema.optional(Schema.Number),
})

export type ViewConfig = typeof ViewConfigSchema.Type

const RESERVED = new Set(LIST_PARAMS)

/** Decoded and re-encoded on every write; this function is the only path in. */
export const encodeViewConfig = (raw: unknown): string => {
  let config: ViewConfig
  try {
    config = Schema.decodeUnknownSync(ViewConfigSchema, { onExcessProperty: "error" })(raw)
  } catch (e) {
    throw new BadRequest({ message: `invalid view config: ${String(e).slice(0, 800)}` })
  }

  if (config.columns) {
    if (config.columns.length > MAX_COLUMNS)
      throw new BadRequest({ message: `invalid view config: more than ${MAX_COLUMNS} columns` })
    if (new Set(config.columns).size !== config.columns.length)
      throw new BadRequest({ message: "invalid view config: duplicate column" })
    for (const column of config.columns)
      if (!FIELD.test(column))
        throw new BadRequest({ message: `invalid view config: column ${JSON.stringify(column)} is not a field name` })
  }
  if (config.filters) {
    const keys = Object.keys(config.filters)
    if (keys.length > MAX_FILTERS)
      throw new BadRequest({ message: `invalid view config: more than ${MAX_FILTERS} filters` })
    for (const key of keys) {
      if (!FIELD.test(key))
        throw new BadRequest({ message: `invalid view config: filter key ${JSON.stringify(key)} is not a field name` })
      if (RESERVED.has(key))
        throw new BadRequest({
          message: `invalid view config: filter key ${JSON.stringify(key)} is a reserved query name`,
        })
      const value = config.filters[key] ?? ""
      if (value.length > MAX_TEXT)
        throw new BadRequest({
          message: `invalid view config: filter value for ${JSON.stringify(key)} over ${MAX_TEXT} chars`,
        })
    }
  }
  if (config.q !== undefined && config.q.length > MAX_TEXT)
    throw new BadRequest({ message: `invalid view config: q over ${MAX_TEXT} chars` })
  if (config.sortBy !== undefined && !FIELD.test(config.sortBy))
    throw new BadRequest({ message: "invalid view config: sortBy is not a field name" })
  if (
    config.pageSize !== undefined &&
    (!Number.isInteger(config.pageSize) || config.pageSize < 1 || config.pageSize > MAX_PAGE_SIZE)
  )
    throw new BadRequest({ message: `invalid view config: pageSize must be an integer 1..${MAX_PAGE_SIZE}` })

  const encoded = JSON.stringify(config)
  if (encoded.length > MAX_CONFIG_BYTES)
    throw new BadRequest({ message: `invalid view config: over ${MAX_CONFIG_BYTES} bytes` })
  return encoded
}

export const encodeViewName = (raw: unknown): string => {
  if (typeof raw !== "string") throw new BadRequest({ message: "invalid view name" })
  const name = raw.trim()
  if (name.length < 1 || name.length > MAX_NAME)
    throw new BadRequest({ message: `invalid view name: 1..${MAX_NAME} chars after trim` })
  return name
}

/** An opaque label, never dereferenced by this cube. Bounded so it stays a label. */
export const encodeTargetCube = (raw: unknown): string => {
  if (typeof raw !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_/-]{0,119}$/.test(raw))
    throw new BadRequest({ message: "invalid targetCube" })
  return raw
}
