import { expect, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { call, login } from "../_layers/api-client.ts"
import { TestServer, testServer, USERS } from "../_layers/test-server.ts"

// QWBE_ALLOWED_ORIGINS is an allowlist: a listed origin is echoed in access-control-allow-origin,
// any other origin gets no header, so the browser blocks the response. Replaces the CORS part of
// probes/external-auth.mjs; token and allowlist parsing are unit-tested in core/src.
const LISTED = ["http://localhost:3000", "https://crm.example.test"] as const
const STRANGER = "https://evil.example.test"

const preflight = (base: string, origin: string) =>
  call(base, "/notes", { method: "OPTIONS", headers: { origin, "access-control-request-method": "GET" } })

const actual = (base: string, origin: string) =>
  call(base, "/auth/login", { method: "POST", headers: { origin }, body: { username: "admin", password: USERS.admin } })

const allowOrigin = (reply: { readonly headers: Readonly<Record<string, string>> }) =>
  reply.headers["access-control-allow-origin"]

const SERVER = { timeout: 60_000, excludeTestServices: true } as const

layer(testServer("cors", { QWBE_ALLOWED_ORIGINS: LISTED.join(",") }), SERVER)("a two-entry allowlist", (it) => {
  it.effect("echoes every listed origin on preflight and on an actual request", () =>
    Effect.gen(function* () {
      const { base } = yield* TestServer
      for (const origin of LISTED) {
        expect(allowOrigin(yield* preflight(base, origin))).toBe(origin)
        expect(allowOrigin(yield* actual(base, origin))).toBe(origin)
      }
    }),
  )

  it.effect("sends no allow header to an unlisted origin", () =>
    Effect.gen(function* () {
      const { base } = yield* TestServer
      expect(allowOrigin(yield* preflight(base, STRANGER))).toBeUndefined()
      expect(allowOrigin(yield* actual(base, STRANGER))).toBeUndefined()
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
      expect(allowOrigin(yield* preflight(base, LISTED[0]))).toBe(LISTED[0])
      expect(allowOrigin(yield* preflight(base, STRANGER))).toBeUndefined()
    }),
  )
})
