import { expect, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { call, login } from "../_layers/api-client.ts"
import { TestServer, testServer, USERS } from "../_layers/test-server.ts"

// The one check that boots core/src/main.ts from login to logout; the rules behind each route live
// in the unit and integration checks.
const LIVE = { timeout: 60_000, excludeTestServices: true } as const

// Every system cube except notes: the kernel must boot and serve without it.
const WITHOUT_NOTES = "account,auth,catalog,cli,customfields,echo,links,permissions,settings,staging,views"

const switchNotes = (base: string, token: string, enabled: boolean) =>
  call(base, "/settings/cubes/notes", { method: "POST", token, body: { enabled } })

const status = (base: string, path: string, token: string) =>
  call(base, path, { token }).pipe(Effect.map((reply) => reply.status))

layer(
  testServer("boot"),
  LIVE,
)((it) => {
  it.effect("refuses a wrong password and hands out an opaque token", () =>
    Effect.gen(function* () {
      const { base } = yield* TestServer
      const wrong = yield* call(base, "/auth/login", { method: "POST", body: { username: "admin", password: "x" } })
      expect(wrong.status).toBe(401)
      expect(yield* login(base, "admin", USERS.admin)).not.toContain(".")
    }),
  )

  it.effect("serves every core cube and an empty package shelf", () =>
    Effect.gen(function* () {
      const { base } = yield* TestServer
      const token = yield* login(base, "admin", USERS.admin)
      for (const path of ["/auth/me", "/notes?limit=1", "/account?limit=5", "/settings/cubes", "/settings/packages"])
        expect([path, yield* status(base, path, token)]).toEqual([path, 200])
    }),
  )

  it.effect("switches a cube off and on, and refuses to switch off a required one", () =>
    Effect.gen(function* () {
      const { base } = yield* TestServer
      const token = yield* login(base, "admin", USERS.admin)
      yield* switchNotes(base, token, false)
      expect(yield* status(base, "/notes?limit=1", token)).toBe(404)
      const required = yield* call(base, "/settings/cubes/settings", {
        method: "POST",
        token,
        body: { enabled: false },
      })
      expect(required.status).toBe(400)
      yield* switchNotes(base, token, true)
      expect(yield* status(base, "/notes?limit=1", token)).toBe(200)
    }),
  )

  it.effect("revokes the token on logout", () =>
    Effect.gen(function* () {
      const { base } = yield* TestServer
      const token = yield* login(base, "admin", USERS.admin)
      expect((yield* call(base, "/auth/logout", { method: "POST", token })).status).toBe(200)
      expect(yield* status(base, "/auth/me", token)).toBe(401)
    }),
  )
})

layer(
  testServer("boot-no-notes", { env: { QWBE_MOUNTED: WITHOUT_NOTES } }),
  LIVE,
)((it) => {
  it.effect("boots without the notes cube, which is simply absent", () =>
    Effect.gen(function* () {
      const { base } = yield* TestServer
      const token = yield* login(base, "admin", USERS.admin)
      expect(yield* status(base, "/auth/me", token)).toBe(200)
      expect(yield* status(base, "/notes?limit=1", token)).toBe(404)
    }),
  )
})
