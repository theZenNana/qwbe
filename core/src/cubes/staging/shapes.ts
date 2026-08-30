// The shape detector -- the one place a value's shape is decided.
//
// The SAME pattern sources feed two consumers:
//   - the JS classifier below, unit-tested in shapes.test.ts;
//   - the SQL classifier in profile.ts, which interpolates them into `~` regular-expression
//     matches so a field is bucketed in ONE pass in the database, never row by row here.
// Both engines get the identical source strings, so the two cannot drift -- change a pattern
// here and both change. (The patterns are deliberately written in the common subset of JS and
// SQL regex syntax: character classes, alternation, quantifiers, anchors. Nothing else.)

/** A string field whose distinct values stay at or under this count is reported as `enum`. */
export const ENUM_MAX_DISTINCT = 12

/** Priority order matters: `12345` is a number, not a phone; `2024-01-02` is a date, not text. */
export const SHAPE_PATTERNS = {
  number: "^-?[0-9]+(\\.[0-9]+)?$",
  date: "^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]+)?)?([+-][0-9]{2}:?[0-9]{2}|Z)?)?$",
  email: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
  phone: "^[(+]?[0-9][0-9 ()\\-.]{5,}$",
} as const

export type Shape = "number" | "date" | "email" | "phone" | "text"

const RES: Record<Shape, RegExp> = {
  number: new RegExp(SHAPE_PATTERNS.number),
  date: new RegExp(SHAPE_PATTERNS.date),
  email: new RegExp(SHAPE_PATTERNS.email),
  phone: new RegExp(SHAPE_PATTERNS.phone),
  text: /.*/,
}

/**
 * Classify ONE value, in priority order. The result is the most specific shape the value fits;
 * `text` is the fallback for any non-empty string (enum vs free text is decided later, from the
 * field's distinct count, not from a single value). `null` means "no value" -- empty string,
 * null, undefined -- and the caller counts the field as not filled.
 */
export const shapeOf = (value: unknown): Shape | null => {
  if (value === null || value === undefined || value === "") return null
  const s = String(value)
  for (const shape of ["number", "date", "email", "phone"] as const) {
    if (RES[shape].test(s)) return shape
  }
  return "text"
}
