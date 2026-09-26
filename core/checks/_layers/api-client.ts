import * as HttpClient from "@effect/platform/HttpClient"
import * as HttpClientRequest from "@effect/platform/HttpClientRequest"
import * as HttpClientResponse from "@effect/platform/HttpClientResponse"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

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

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

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

/** One request to `base + path`; any status comes back, only a transport failure dies. */
export const call = (base: string, path: string, options: CallOptions = {}) =>
  HttpClient.execute(request(`${base}${path}`, options)).pipe(
    Effect.flatMap(reply),
    Effect.timeout("10 seconds"),
    Effect.orDie,
  )

/** Logs in and returns the session token; a refused login or a malformed reply fails the test. */
export const login = (base: string, username: string, password: string) =>
  HttpClient.execute(request(`${base}/auth/login`, { method: "POST", body: { username, password } })).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Session)),
    Effect.map(({ token }) => token),
    Effect.timeout("10 seconds"),
    Effect.orDie,
  )
