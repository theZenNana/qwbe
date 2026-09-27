// JSON over HTTP to a running kernel: `qwbe check` (readiness, generic probes) and the check
// suites talk to the server they booted through these.

import { HttpClient, HttpClientRequest, type HttpClientResponse } from "@effect/platform"
import { Effect, Option, Schema } from "effect"

export interface Reply {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: unknown
}

export interface CallOptions {
  readonly method?: HttpClientRequest.HttpClientRequest["method"]
  readonly token?: string
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
}

const Session = Schema.Struct({ token: Schema.NonEmptyString })

/** The session token in a login reply body, if it carries one. */
export const sessionToken = (body: unknown) =>
  Option.map(Schema.decodeUnknownOption(Session)(body), ({ token }) => token)

const decodeJson = Schema.decodeUnknownOption(Schema.parseJson())

/** A JSON body decoded; any other body stays its text. */
const parse = (text: string): unknown => Option.getOrElse(decodeJson(text), () => text)

const request = (url: string, { method = "GET", token, body, headers = {} }: CallOptions) =>
  HttpClientRequest.make(method)(url).pipe(
    HttpClientRequest.setHeaders(headers),
    token === undefined ? (req) => req : HttpClientRequest.bearerToken(token),
    body === undefined ? (req) => req : HttpClientRequest.bodyUnsafeJson(body),
  )

const reply = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.map(
    response.text,
    (text): Reply => ({ status: response.status, headers: response.headers, body: parse(text) }),
  )

/** One request to `base + path`; any status comes back, a transport failure or a timeout fails. */
export const send = (base: string, path: string, options: CallOptions = {}) =>
  HttpClient.execute(request(`${base}${path}`, options)).pipe(Effect.flatMap(reply), Effect.timeout("10 seconds"))

/** `send`, where a transport failure dies: the server was booted by the caller and must answer. */
export const call = (base: string, path: string, options: CallOptions = {}) => Effect.orDie(send(base, path, options))

const isOk = (status: number): boolean => status >= 200 && status < 300

/** Logs in and returns the session token; a refused login or a malformed reply fails the test. */
export const login = (base: string, username: string, password: string) =>
  call(base, "/auth/login", { method: "POST", body: { username, password } }).pipe(
    Effect.filterOrDieMessage(({ status }) => isOk(status), `login of ${username} refused`),
    Effect.flatMap(({ body }) => sessionToken(body)),
    Effect.orDieWith(() => new Error(`login of ${username} returned no session token`)),
  )
