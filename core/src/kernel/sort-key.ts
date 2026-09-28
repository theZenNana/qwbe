// Engine-independent sort keys (Qwbe#73). The store writes one key per sortable field into the
// reserved body sub-object `_sort`, and lists order by that key compared as bytes, then by id.
// The order of a list is therefore decided HERE, in JavaScript, and not by the database's
// collation or its JSON ordering: any engine that compares ASCII text bytewise sorts the same.
//
// A key is a type tag, then a payload, all in [0-9a-f]. The tag keeps types from interleaving:
//
//   null "0" < boolean "1" < number "2" < string "3"
//
// A value of any other JSON type (an array, an object) sorts as the string of its JSON text.
//
// Timestamps need nothing special: `DateTime.formatIso` emits `Date.prototype.toISOString`,
// fixed-width `YYYY-MM-DDTHH:mm:ss.sssZ` in UTC for years 0000-9999, so their folded strings
// compare in time order (sort-key.test.ts pins that down).

/** Bump when `sortKey` changes: the boot backfill rewrites every row carrying another version. */
export const SORT_KEY_VERSION = 1

/** The reserved body key holding the sort keys. The store writes it and `decode` strips it. */
export const SORT_KEYS = "_sort"

/** Leading bytes of a folded string that make it into its key; longer ties fall to `id`. */
const STRING_BYTES = 32

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex")

/** float64 big-endian, sign bit flipped when >= 0 and every bit inverted when < 0. */
const numberKey = (n: number): string => {
  const view = new DataView(new ArrayBuffer(8))
  // -0 + 0 is 0: the two zeros compare equal, so they get one key.
  view.setFloat64(0, n + 0)
  const hi = view.getUint32(0)
  const lo = view.getUint32(4)
  const negative = hi >>> 31 === 1
  view.setUint32(0, negative ? ~hi >>> 0 : (hi ^ 0x80000000) >>> 0)
  view.setUint32(4, negative ? ~lo >>> 0 : lo)
  return hex(new Uint8Array(view.buffer))
}

/** NFKD, combining marks removed, lower case: one fold rule for every user. */
export const foldText = (s: string): string => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()

const stringKey = (s: string): string => hex(new TextEncoder().encode(foldText(s)).subarray(0, STRING_BYTES))

export const sortKey = (value: unknown): string => {
  if (value === null || value === undefined) return "0"
  if (typeof value === "boolean") return value ? "11" : "10"
  if (typeof value === "number") return `2${numberKey(value)}`
  // ponytail: arrays and objects sort as their JSON text; give them a tag if a cube sorts on one.
  return `3${stringKey(typeof value === "string" ? value : JSON.stringify(value))}`
}

export type SortKeys = { readonly v: number; readonly k: Readonly<Record<string, string>> }

/**
 * The `_sort` sub-object for a body: the version, and under `k` one key per sortable field the
 * body carries (a field named `v` cannot shadow the version). Undefined when the body carries
 * none of the fields, so tables without sortable fields stay untouched.
 */
export const sortKeysFor = (body: Record<string, unknown>, fields: ReadonlyArray<string>): SortKeys | undefined => {
  const present = fields.filter((f) => body[f] !== undefined)
  if (present.length === 0) return undefined
  return { v: SORT_KEY_VERSION, k: Object.fromEntries(present.map((f) => [f, sortKey(body[f])])) }
}

/** `body` with its `_sort` recomputed from scratch: a caller-supplied `_sort` never survives. */
export const withSortKeys = (body: Record<string, unknown>, fields: ReadonlyArray<string>): Record<string, unknown> => {
  const { [SORT_KEYS]: _drop, ...rest } = body
  const keys = sortKeysFor(rest, fields)
  return keys === undefined ? rest : { ...rest, [SORT_KEYS]: keys }
}
