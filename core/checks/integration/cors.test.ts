import { expect, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { call } from "../_layers/api-client.ts"
import { TestServer, testServer } from "../_layers/test-server.ts"

// QWBE_ALLOWED_ORIGINS is an allowlist: a listed origin gets itself echoed back in
// access-control-allow-origin, any other origin gets no header, so the browser blocks it.
const LISTED = ["http://localhost:3000", "https://crm.example.test"]
const STRANGER = "https://evil.example.test"

const allowOrigin = (base: string, method: string, path: string, origin: string) =>
  call(base, path, {
    method,
    headers: { origin, "access-control-request-method": "GET" },
    ...(method === "POST" ? { body: { username: "admin", password: "admin" } } : {}),
  }).pipe(Effect.map((reply) => reply.headers["access-control-allow-origin"]))

layer(testServer("cors", { env: { QWBE_ALLOWED_ORIGINS: LISTED.join(",") } }), {
  timeout: 60_000,
  excludeTestServices: true,
})((it) => {
  it.effect("echoes every listed origin on preflight and on an actual request", () =>
    Effect.gen(function* () {
      const { base } = yield* TestServer
      for (const origin of LISTED) {
        expect(yield* allowOrigin(base, "OPTIONS", "/notes", origin)).toBe(origin)
        expect(yield* allowOrigin(base, "POST", "/auth/login", origin)).toBe(origin)
      }
    }),
  )

  it.effect("sends no allow header to an unlisted origin", () =>
    Effect.gen(function* () {
      const { base } = yield* TestServer
      expect(yield* allowOrigin(base, "OPTIONS", "/notes", STRANGER)).toBeUndefined()
      expect(yield* allowOrigin(base, "POST", "/auth/login", STRANGER)).toBeUndefined()
    }),
  )

  it.effect("answers a request without Origin, as a server-to-server client sends it", () =>
    Effect.gen(function* () {
      const { base } = yield* TestServer
      expect((yield* call(base, "/openapi.json")).status).toBe(401)
    }),
  )
})
