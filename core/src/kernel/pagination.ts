// Pagination lives in the CONTRACT, not in each implementation.
//
// The previous iteration had `search(field, value)` returning every match. That is not an
// oversight you fix later — it is in the type, so it survives a database change and can only
// be removed by breaking every cube written against it. At five cubes that is an afternoon;
// at forty it never happens and the system is slow by construction.
//
// `total` is required, not optional. Without it the UI cannot render "1-10 of 400" and ends
// up fetching every row just to count them — the same problem, moved to the frontend.

import { Schema } from "effect"

export { PageOf } from "../http-contracts.ts"

export const DEFAULT_LIMIT = 25
export const MAX_LIMIT = 200

export type PageRequest = {
  readonly offset: number
  readonly limit: number
  /**
   * `| undefined` on purpose: `pageRequest` below returns this key SET to undefined when the
   * caller asked for a field that is not safe to sort by. Under `exactOptionalPropertyTypes`,
   * `sortBy?: string` alone would mean "absent or a string" and reject that — so the type would
   * have described a function nobody wrote. Dropping the key instead would change what callers
   * see at runtime (`"sortBy" in page`), which is a bigger change than being honest here.
   */
  readonly sortBy?: string | undefined
  readonly descending?: boolean | undefined
}

export type Page<A> = {
  readonly rows: ReadonlyArray<A>
  readonly total: number
  readonly offset: number
  readonly limit: number
  /**
   * The ordering ACTUALLY applied.
   *
   * A caller may ask to sort by a field the cube does not publish as sortable. Refusing is one
   * answer; silently ignoring is another — and silent discarding is precisely what this
   * prototype calls a defect at the CLI gate, so it cannot be acceptable here either. A reviewer
   * caught the inconsistency: one door refuses loudly, the other swallowed.
   *
   * Saying what happened beats both. The caller gets their answer and can see the request was
   * not honoured — no error for something harmless, and no quiet lie.
   */
  readonly sortedBy: string
}

/** Query parameters, for HttpApi contracts. */
/**
 * `sortBy` must be a plain identifier.
 *
 * It is not an injection risk — the value is bound as a parameter to `json_extract`, and a
 * reviewer confirmed five injection attempts change nothing. But the JSON path is built by
 * concatenation, so `?sortBy="` or `?sortBy=[0]` produced an invalid path, SQLite threw, and
 * the exception escaped as a defect: HTTP 500 with an empty body, from a query string.
 *
 * Enforcing the shape in the schema means a bad value is a 400 with a reason, decided in the
 * contract and visible in the emitted OpenAPI — rather than being dropped silently, which is
 * the failure mode criticised elsewhere in this prototype.
 */
const SortField = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z_][A-Za-z0-9_]*$/, {
    message: () => "sortBy must be a field name: a letter or underscore, then letters, digits or underscores",
  }),
)

export const PageParams = Schema.Struct({
  offset: Schema.optionalWith(Schema.NumberFromString, { default: () => 0 }),
  limit: Schema.optionalWith(Schema.NumberFromString, { default: () => DEFAULT_LIMIT }),
  sortBy: Schema.optional(SortField),
  descending: Schema.optionalWith(Schema.BooleanFromString, { default: () => false }),
})

/** Response shape. `total` is in the schema, so it shows up in the emitted OpenAPI. */
/**
 * Normalise a request. The limit is capped HARD at `MAX_LIMIT`.
 *
 * The cap is not politeness. Without it `?limit=999999` reintroduces the exact problem this
 * contract exists to prevent — and reintroduces it from outside, where no code review sees it.
 */
const SAFE_FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * `Math.trunc` keeps `NaN` and `Infinity`, which is how a 500 got through.
 *
 * `?limit=abc` fails `NumberFromString` and produces a clean 400. But `?offset=NaN` and
 * `?offset=1e400` PARSE as numbers, survived `Math.trunc`, reached the SQLite bind, and came
 * back as `datatype mismatch` — an uncaught defect, so HTTP 500 with an empty body, on every
 * route that takes page parameters. Found by review after the same class of bug was closed for
 * `sortBy`; the lesson is that "normalised" has to mean finite, not merely truncated.
 */
// Finite is not enough either: `?offset=99999999999999999999` parses to 1e20, which is a
// perfectly finite number and still larger than the 64-bit integer SQLite can bind — same
// `datatype mismatch`, same empty 500. Clamping to the safe-integer range closes the last of it.
const finiteInt = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(-Number.MAX_SAFE_INTEGER, Math.trunc(value as number)))
    : fallback

export const pageRequest = (p: Partial<PageRequest> = {}): PageRequest => ({
  offset: Math.max(0, finiteInt(p.offset, 0)),
  limit: Math.min(MAX_LIMIT, Math.max(1, finiteInt(p.limit, DEFAULT_LIMIT))),
  // Belt and braces: the schema already rejects a malformed field, but this function is also
  // called from cube code, where nothing forces the value through the schema first.
  sortBy: p.sortBy && SAFE_FIELD.test(p.sortBy) ? p.sortBy : undefined,
  descending: p.descending ?? false,
})
