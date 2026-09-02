// Every refused request says so, once, at the point it leaves the kernel. One middleware,
// not an edit at each refusal site: every 401 and 403 in the system leaves through a
// response, so this sees all of them. The token is NEVER logged, not even truncated (a
// truncated token is still a secret); what is logged is sha256(token) cut to 12 hex
// characters -- stable across attempts, worthless to whoever reads it.

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
