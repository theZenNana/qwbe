import * as Effect from "effect/Effect"

export interface Reply {
  readonly status: number
  readonly body: unknown
  readonly headers: Readonly<Record<string, string>>
}

export interface CallOptions {
  readonly method?: string
  readonly token?: string
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** One HTTP request to the server at `base`; the body comes back parsed when it is JSON. */
export const call = (base: string, path: string, options: CallOptions = {}) =>
  Effect.tryPromise(async (): Promise<Reply> => {
    const response = await fetch(`${base}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    })
    return {
      status: response.status,
      body: parse(await response.text()),
      headers: Object.fromEntries(response.headers),
    }
  }).pipe(Effect.orDie)

/** Logs in and returns the session token, or fails the test when login is refused. */
export const login = (base: string, username: string, password: string) =>
  call(base, "/auth/login", { method: "POST", body: { username, password } }).pipe(
    Effect.map((reply) => (reply.body as { token?: string }).token),
    Effect.flatMap((token) => (token ? Effect.succeed(token) : Effect.dieMessage(`login refused for ${username}`))),
  )
