// Browser origins allowed to call the API cross-origin, read from
// QWBE_ALLOWED_ORIGINS as a comma-separated list (e.g.
// `http://localhost:3000,https://crm.example.com`).
//
// Default when the variable is undefined: `["*"]` -- no restriction, so local development
// (the sibling web app on its own port, the probes, curl)
// keeps working with zero configuration. A variable that is SET but empty or whitespace-only
// is a malformed value and fails, like any other malformed entry -- `VAR=$MISSING` shipping
// an accidentally empty value must not silently widen the server back to `*`.
//
// With the variable set, the list is exact: an origin not in it gets no
// `access-control-allow-origin` header and the browser blocks the response. Entries are
// canonicalized through `new URL(entry).origin`, so `https://a.test:443` and `HTTPS://a.test`
// match the default-port-stripped, lowercased form browsers actually send.
//
// Malformed entries (empty items from stray commas, values without a scheme, hosts with
// characters outside hostname/port syntax, wildcard hosts like `https://*.example.com`)
// fail with a clear message rather than being dropped silently -- a dropped entry would look
// like "one origin allowed" while actually being "none", and the mismatch would only surface
// as a browser CORS error far from its cause. Wildcard subdomains are unsupported because the
// CORS layer matches exactly; an entry like `https://*.example.com` could never match and
// would be stamped verbatim onto every response. The failure is a typed `OriginsRefused`; the
// server maps it to exit code 2 at its edge.

import { Data, Effect, Either, ParseResult, Schema } from "effect"
import { QwbeConfig } from "./config.ts"

const ORIGIN_PATTERN = /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?$/i

export const isWildcardDefault = (origins: ReadonlyArray<string>): boolean => origins.length === 1 && origins[0] === "*"

// The unset default exists so local development needs no configuration, but a deployment
// that merely forgot the variable must not look identical to a configured one: the server
// prints this warning at startup, and refuses to start entirely in production.
export const wildcardDefaultWarning =
  "WARNING: QWBE_ALLOWED_ORIGINS is not set -- CORS allows every origin. Set it to your frontend origins before exposing this server."
export const wildcardDefaultRefusal =
  "QWBE_ALLOWED_ORIGINS is not set -- refusing to start with CORS wide open in production"

/** A malformed QWBE_ALLOWED_ORIGINS, or the unset default in production. The boot stops. */
export class OriginsRefused extends Data.TaggedError("OriginsRefused")<{ readonly message: string }> {}

// The CORS layer gets a PREDICATE, not an array: Effect's cors middleware only checks the
// request Origin when the array has more than one entry (a one-entry array stamps its
// constant value on every response, listed origin or not). The function branch is evaluated
// per request for any list length. The unset `["*"]` default stays an array: Effect stamps
// the literal `*` constant on every response (the unset default, no restriction).
export const corsOriginMatcher = (
  origins: ReadonlyArray<string>,
): ReadonlyArray<string> | ((origin: string) => boolean) =>
  isWildcardDefault(origins) ? ["*"] : (origin) => origins.includes(origin)

// The server's startup path: parse the variable, warn on the unset default (refuse to start
// in production), fail with one clear line on malformed values. Lives here so main.ts stays
// thin; the policy and its messages are origin policy.
export const originsForStartup = Effect.gen(function* () {
  const { allowedOrigins: env, nodeEnv } = yield* QwbeConfig
  const origins = yield* allowedOrigins(env)
  if (isWildcardDefault(origins)) {
    if (nodeEnv === "production") return yield* new OriginsRefused({ message: wildcardDefaultRefusal })
    yield* Effect.logWarning(wildcardDefaultWarning)
  }
  return origins
})

/** The set variable: comma-separated bare origins, canonicalized. Malformed is a parse failure. */
export const AllowedOrigins = Schema.transformOrFail(Schema.String, Schema.Array(Schema.String), {
  strict: true,
  decode: (env, _, ast) => {
    const refuse = (message: string) => ParseResult.fail(new ParseResult.Type(ast, env, message))
    const canonical: string[] = []
    for (const [index, origin] of env
      .split(",")
      .map((o) => o.trim())
      .entries()) {
      if (origin === "")
        return refuse(
          `QWBE_ALLOWED_ORIGINS: empty origin at position ${index + 1} -- check for stray or doubled commas`,
        )
      if (origin.includes("*"))
        return refuse(
          `QWBE_ALLOWED_ORIGINS: "${origin}" uses a wildcard -- wildcard subdomains are unsupported, list origins exactly`,
        )
      if (!ORIGIN_PATTERN.test(origin))
        return refuse(
          `QWBE_ALLOWED_ORIGINS: "${origin}" is not a bare origin -- expected scheme://host[:port], no path, no trailing slash`,
        )
      canonical.push(new URL(origin).origin)
    }
    return ParseResult.succeed(canonical)
  },
  encode: (origins) => ParseResult.succeed(origins.join(",")),
})

export const allowedOrigins = (env: string | undefined): Either.Either<ReadonlyArray<string>, OriginsRefused> =>
  // Only an UNSET variable defaults to `["*"]`. A set-but-empty or whitespace-only value is
  // malformed and fails -- see the module comment.
  env === undefined
    ? Either.right(["*"])
    : Schema.decodeEither(AllowedOrigins)(env).pipe(
        Either.mapLeft(
          (e) =>
            new OriginsRefused({ message: ParseResult.ArrayFormatter.formatErrorSync(e)[0]?.message ?? e.message }),
        ),
      )
