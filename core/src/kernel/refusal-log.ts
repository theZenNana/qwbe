// Every refused request says so, once, at the point it leaves the kernel.
//
// Until 2026-08-31 a 401 or a 403 left no trace at all. The owner was thrown out of a frontend
// seconds after logging in and nothing in the kernel's output said that a token had been
// refused, which token, or where it came from. (The cause was a session cookie shared between
// two stacks on localhost -- browsers do not scope cookies by port -- so the kernel kept being
// handed a token it had never issued. Refusing was right; refusing silently was not.)
//
// One middleware rather than an edit at each refusal site. Every 401 and 403 in the system
// leaves through a response, so this sees all of them -- the auth middleware's, the permission
// check's, an entity-sharing refusal inside a cube, and any that gets written next year. There
// is no way to add a silent one. The reason travels in the error body the cube already
// produces, so no cube has to learn that logging exists.
//
// The token is NEVER logged, not even truncated: a truncated token is still a secret, just a
// shorter one. What is logged is `sha256(token)` cut to 12 hex characters -- stable, so two
// attempts carrying the same token correlate in the log, and worthless to whoever reads it.

import { createHash } from "node:crypto"
import { HttpMiddleware, HttpServerRequest, type HttpServerResponse } from "@effect/platform"
import { Effect, Option } from "effect"

/** A short, stable, non-reversible handle for the bearer token a request carried. */
export const tokenHandle = (authorization: string | undefined): string => {
  const token = /^Bearer\s+(\S.*)$/i.exec((authorization ?? "").trim())?.[1]?.trim()
  if (!token) return "-"
  return createHash("sha256").update(token).digest("hex").slice(0, 12)
}

/** The reason and the permission out of the error body a refusal already carries. */
const stated = (response: HttpServerResponse.HttpServerResponse): { reason: string; needed: string } => {
  const body = response.body
  // A refusal body is small JSON. Anything else (a stream, a file, an empty body) is left
  // alone: reading it here would consume it, and the status alone is still worth a line.
  if (body._tag !== "Uint8Array" || body.body.length > 4096) return { reason: "unstated", needed: "-" }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body.body)) as {
      readonly message?: unknown
      readonly needed?: unknown
    }
    return {
      reason: typeof parsed.message === "string" && parsed.message !== "" ? parsed.message : "unstated",
      needed: typeof parsed.needed === "string" && parsed.needed !== "" ? parsed.needed : "-",
    }
  } catch {
    return { reason: "unstated", needed: "-" }
  }
}

/** Where the request came from: the socket, or the proxy header when one is in front. */
export const callerOf = (headers: Readonly<Record<string, string>>, remoteAddress: Option.Option<string>): string =>
  Option.getOrElse(remoteAddress, () => headers["x-forwarded-for"] ?? "unknown")

/**
 * The line itself, built from plain values so it can be tested without a server.
 *
 * `route` drops the query string: a query string is caller-supplied and has held credentials
 * in every system that ever logged one.
 */
export const refusalLine = (
  request: Pick<HttpServerRequest.HttpServerRequest, "method" | "url" | "headers" | "remoteAddress">,
  response: Pick<HttpServerResponse.HttpServerResponse, "status" | "body">,
): string => {
  const handle = tokenHandle(request.headers.authorization)
  const { reason: body, needed } = stated(response as HttpServerResponse.HttpServerResponse)
  // An empty-bodied 401 states nothing -- the OpenAPI route deliberately answers with no body
  // at all. The request still says which of the two it was, and that is the half worth having.
  const reason = body !== "unstated" ? body : handle === "-" ? "no token" : "token refused"
  const route = request.url.split("?")[0] ?? request.url
  return (
    `auth-refused status=${response.status} method=${request.method} route=${route} ` +
    `reason="${reason}" needed=${needed} from=${callerOf(request.headers, request.remoteAddress)} ` +
    `token=${handle}`
  )
}

/** Wrap the app: every 401 and 403 it answers with gets one warning line. */
export const logRefusals = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const response = yield* app
    if (response.status === 401 || response.status === 403) {
      yield* Effect.logWarning(refusalLine(request, response))
    }
    return response
  }),
)
