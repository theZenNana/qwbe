// The custom-field VALUE policy, pure and testable (QWB-46 review fixes 1, 2, 3, 7, 14, 15).
//
// Values live in the target row's `custom` sub-object, written through the TARGET cube's own
// API. That write path is only honest if three things hold, and all three live here:
//
//   1. A cube with NO active definitions gets exactly its old behavior: undeclared keys are
//      stripped, nothing is stored. Writing custom values requires a definition -- otherwise
//      the admin-only `customfields:write` gate on definitions would be decorative.
//   2. A value written on the real write path is checked against its definition BEFORE the
//      fold. A definition of `number` does not accept an object, whatever endpoint it arrives
//      through. Undefined keys are rejected outright, never stored.
//   3. One request cannot write an unbounded jsonb blob into a GIN-indexed row body: the key
//      count and the serialized size of the `custom` object are capped here, in one place.

/** The reserved sub-object of a row body where undeclared keys are kept. One name, everywhere. */
export const CUSTOM = "custom"

/** A definition, in the vocabulary the kernel's catalogue publishes (catalogue.ts). */
export type CustomFieldDef = {
  readonly name: string
  readonly fieldType: "text" | "number" | "date" | "bool" | "select"
  readonly required: boolean
  readonly options: ReadonlyArray<string>
}

/** How many keys one `custom` object may hold. A form does not need more. */
export const MAX_CUSTOM_KEYS = 32

/** The serialized `custom` object cap, in bytes of JSON. A row body is not a file store. */
export const MAX_CUSTOM_BYTES = 8192

export type FoldResult =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly message: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// Keys that can never be plain data: assigning them through a normal object literal hits the
// `Object.prototype` setters and silently drops or poisons the value. The custom object is
// built with a null prototype, and these names are refused on top -- belt and braces, because
// a null prototype already makes the assignment safe.
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])

/**
 * One value against one definition, returning the reason rather than a boolean. JSON values
 * arrive typed, so `number` wants a finite number (a numeric string is accepted -- the
 * validate-only endpoint and forms send strings), `bool` wants a boolean or "true"/"false".
 */
export const checkCustomValue = (def: CustomFieldDef, value: unknown): string | undefined => {
  if (value === "" || value === null || value === undefined) {
    return def.required ? `"${def.name}" is required and cannot be emptied` : undefined
  }
  const asString = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value))
  switch (def.fieldType) {
    case "text":
      return typeof value === "string"
        ? value.length > 1000
          ? `"${def.name}" is longer than 1000 characters`
          : undefined
        : `"${def.name}" must be text`
    case "number":
      return Number.isFinite(Number(value)) ? undefined : `"${def.name}" must be a number`
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(asString) && !Number.isNaN(Date.parse(asString))
        ? undefined
        : `"${def.name}" must be a date as YYYY-MM-DD`
    case "bool":
      return typeof value === "boolean" || value === "true" || value === "false"
        ? undefined
        : `"${def.name}" must be a boolean`
    case "select":
      return def.options.includes(asString) ? undefined : `"${asString}" is not one of the options for "${def.name}"`
  }
}

/**
 * Move undeclared payload keys into `payload.custom` -- or refuse the request.
 *
 * `defs` is the cube's ACTIVE custom-field definitions, read at request time: an empty list
 * means the fold is OFF (undeclared keys are stripped, the pre-QWB-46 behavior), and a key
 * with no definition is a 400, not a silent store. Declared keys -- including a field the
 * cube literally named `custom` -- are never touched.
 */
export const foldCustom = (
  payload: unknown,
  declared: ReadonlyArray<string>,
  defs: ReadonlyArray<CustomFieldDef>,
): FoldResult => {
  if (!isRecord(payload)) return { ok: true, payload }
  const known = new Set(declared)
  // A cube that declares a field literally named `custom` owns the name: the fold never runs
  // for it. Undeclared keys are stripped (the fold-off behavior); the declared field passes.
  if (known.has(CUSTOM)) {
    const keptOnly: Record<string, unknown> = {}
    let stripped = false
    for (const [key, value] of Object.entries(payload)) {
      if (known.has(key)) keptOnly[key] = value
      else stripped = true
    }
    return stripped ? { ok: true, payload: keptOnly } : { ok: true, payload }
  }
  const byName = new Map(defs.map((d) => [d.name, d]))
  const custom: Record<string, unknown> = Object.create(null) as Record<string, unknown>

  const accept = (name: string, value: unknown): string | undefined => {
    if (UNSAFE_KEYS.has(name)) return `"${name}" is not an allowed field name`
    const def = byName.get(name)
    if (!def) return `"${name}" is not a defined custom field on this cube`
    const why = checkCustomValue(def, value)
    return why // undefined means accepted
  }

  // The custom object the caller sent explicitly is validated like any other value.
  if (payload[CUSTOM] !== undefined) {
    if (!isRecord(payload[CUSTOM])) return { ok: false, message: `"${CUSTOM}" must be an object` }
    for (const [name, value] of Object.entries(payload[CUSTOM])) {
      if (defs.length === 0) continue // fold is off: the whole object is stripped below
      const why = accept(name, value)
      if (why) return { ok: false, message: why }
      custom[name] = value
    }
  }

  let moved = false
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    // A cube that declares a field literally named `custom` keeps it as a plain field: the
    // declared-name check runs BEFORE the reserved-name branch (review fix 14).
    if (known.has(key)) {
      kept[key] = value
      continue
    }
    if (key === CUSTOM) {
      moved = true
      continue
    }
    if (UNSAFE_KEYS.has(key)) return { ok: false, message: `"${key}" is not an allowed field name` }
    moved = true
    if (defs.length === 0) continue // no active definitions: strip, the old behavior
    const why = accept(key, value)
    if (why) return { ok: false, message: why }
    custom[key] = value
  }
  if (!moved && Object.keys(custom).length === 0) return { ok: true, payload }
  if (Object.keys(custom).length === 0) return { ok: true, payload: kept }

  // The caps: one request cannot grow `custom` without bound (review fix 3).
  if (Object.keys(custom).length > MAX_CUSTOM_KEYS) {
    return { ok: false, message: `too many custom fields: the cap is ${MAX_CUSTOM_KEYS}` }
  }
  const serialized = JSON.stringify(custom) ?? "{}"
  if (serialized.length > MAX_CUSTOM_BYTES) {
    return { ok: false, message: `custom values too large: the cap is ${MAX_CUSTOM_BYTES} bytes` }
  }
  return { ok: true, payload: { ...kept, [CUSTOM]: { ...custom } } }
}
