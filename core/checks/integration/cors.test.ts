import { expect, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { call, login } from "../../src/api-client.ts"
import { TestServer, testServer, USERS } from "../_layers/test-server.ts"

// QWBE_ALLOWED_ORIGINS is an allowlist: a listed origin is echoed in access-control-allow-origin,
// any other origin gets no header, so the browser blocks the response. Replaces the CORS part of
// probes/external-auth.mjs; token and allowlist parsing are unit-tested in core/src.
const LISTED = ["http://localhost:3000", "https://crm.example.test"] as const
const STRANGER = "https://evil.example.test"

const ALLOW_ORIGIN = "access-control-allow-origin"

/** The allow-origin header a preflight from `origin` gets back. */
const preflightAllows = (base: string, origin: string) =>
  call(base, "/notes", { method: "OPTIONS", headers: { origin, "access-control-request-method": "GET" } }).pipe(
    Effect.map((reply) => reply.headers[ALLOW_ORIGIN]),
  )

/** The allow-origin header an actual request (a login) from `origin` gets back. */
const requestAllows = (base: string, origin: string) =>
  call(base, "/auth/login", {
    method: "POST",
    headers: { origin },
    body: { username: "admin", password: USERS.admin },
  }).pipe(Effect.map((reply) => reply.headers[ALLOW_ORIGIN]))

const SERVER = { timeout: 60_000, excludeTestServices: true } as const

layer(testServer("cors", { QWBE_ALLOWED_ORIGINS: LISTED.join(",") }), SERVER)("a two-entry allowlist", (it) => {
  it.effect("echoes every listed origin on preflight and on an actual request", () =>
    Effect.gen(function* () {
      const { base } = yield* TestServer
      for (const origin of LISTED) {
        expect(yield* preflightAllows(base, origin)).toBe(origin)
        expect(yield* requestAllows(base, origin)).toBe(origin)
      }
    }),
  )

  it.effect("sends no allow header to an unlisted origin", () =>
    Effect.gen(function* () {
      const { base } = yield* TestServer
      expect(yield* preflightAllows(base, STRANGER)).toBeUndefined()
      expect(yield* requestAllows(base, STRANGER)).toBeUndefined()
    }),
  )

  it.effect("lets a client without Origin log in, as a server-to-server client does", () =>
    Effect.gen(function* () {
      const { base } = yield* TestServer
      expect(yield* login(base, "admin", USERS.admin)).not.toBe("")
    }),
  )
})

// Effect's cors middleware compares the Origin only for arrays longer than one; the server passes
// a predicate, so a single entry must filter like many.
layer(testServer("cors1", { QWBE_ALLOWED_ORIGINS: LISTED[0] }), SERVER)("a single-entry allowlist", (it) => {
  it.effect("echoes the listed origin and refuses a stranger", () =>
    Effect.gen(function* () {
      const { base } = yield* TestServer
      expect(yield* preflightAllows(base, LISTED[0])).toBe(LISTED[0])
      expect(yield* preflightAllows(base, STRANGER)).toBeUndefined()
    }),
  )
})
