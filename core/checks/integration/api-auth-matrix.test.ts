import * as HttpMethod from "@effect/platform/HttpMethod"
import { expect, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Unauthorized } from "../../src/kernel/errors.ts"
import { call, login } from "../_layers/api-client.ts"
import { TestServer, testServer, USERS } from "../_layers/test-server.ts"

// Replaces the anonymous 401 matrix of probes/contract.mjs, the token and switched-off checks of
// probes/security.mjs and security-boundaries.mjs, "no hash" of security-injection.mjs and
// "404 without permission" of cube-metadata.mjs. The published inventory itself is
// checks/unit/api-inventory.test.ts.

const HASH = /passwordHash|[a-f0-9]{64}/
// Decoded, not `Schema.is`: the wire body is the encoded side, a plain object, not a class instance.
const isUnauthorized = (body: unknown) => Option.isSome(Schema.decodeUnknownOption(Unauthorized)(body))

type Route = readonly [method: HttpMethod.HttpMethod, path: string]

const isLogin = ([method, path]: Route) => method === "POST" && path === "/auth/login"

const fillParams = (path: string) => path.replaceAll(/\{[^}]+\}/g, "check-missing")

/** Pure: every published operation except login, path parameters filled with a placeholder. */
const protectedRoutes = (paths: Readonly<Record<string, object>>): ReadonlyArray<Route> =>
  Object.entries(paths)
    .flatMap(([path, item]) =>
      Object.keys(item)
        .map((key) => key.toUpperCase())
        .filter(HttpMethod.isHttpMethod)
        .map((method): Route => [method, fillParams(path)]),
    )
    .filter((route) => !isLogin(route))

// Authentication runs before payload decoding, so an empty object is inert for every mutation.
const anonymous = (base: string, [method, path]: Route) =>
  call(base, path, { method, ...(method === "GET" || method === "DELETE" ? {} : { body: {} }) })

const refusedAsDeclared = (reply: { readonly status: number; readonly body: unknown }) =>
  reply.status === 401 && isUnauthorized(reply.body)

const switchCube = (base: string, token: string, cube: string, enabled: boolean) =>
  call(base, `/settings/cubes/${cube}`, { method: "POST", token, body: { enabled } })

const asAdmin = Effect.flatMap(TestServer, ({ base }) =>
  Effect.map(login(base, "admin", USERS.admin), (token) => ({ base, token })),
)

const asReader = Effect.flatMap(TestServer, ({ base }) =>
  Effect.map(login(base, "reader", USERS.reader), (token) => ({ base, token })),
)

const reEnableNotes = Effect.flatMap(asAdmin, ({ base, token }) => switchCube(base, token, "notes", true))

layer(testServer("authmatrix"), { timeout: 60_000, excludeTestServices: true })("the auth matrix", (it) => {
  it.effect("every protected route answers an anonymous caller with its declared 401", () =>
    Effect.gen(function* () {
      const { base, token } = yield* asAdmin
      const spec = yield* call(base, "/openapi.json", { token })
      const routes = protectedRoutes((spec.body as { paths: Record<string, object> }).paths)
      const replies = yield* Effect.forEach(routes, (route) => anonymous(base, route), { concurrency: 8 })
      expect(routes.length).toBeGreaterThan(0)
      expect(routes.filter((_, i) => !refusedAsDeclared(replies[i]!))).toEqual([])
    }),
  )

  it.effect("a forged, an empty and a scheme-less token are all 401", () =>
    Effect.gen(function* () {
      const { base, token } = yield* asAdmin
      for (const authorization of [`Bearer ${"a".repeat(43)}`, "Bearer ", token]) {
        expect((yield* call(base, "/auth/me", { headers: { authorization } })).status).toBe(401)
      }
    }),
  )

  it.effect("a switched-off cube is indistinguishable from a missing one", () =>
    Effect.gen(function* () {
      const { base, token } = yield* asAdmin
      yield* switchCube(base, token, "notes", false)
      expect((yield* call(base, "/notes?limit=1", { token })).status).toBe(404)
      expect((yield* call(base, "/notes")).body).toEqual((yield* call(base, "/nosuchcube")).body)
      const command = yield* call(base, "/cli/exec", { method: "POST", token, body: { line: "notes:count" } })
      expect(command.status).toBe(400)
      const entities = (yield* call(base, "/links", { token })).body as ReadonlyArray<{ cube: string }>
      expect(entities.map((entity) => entity.cube)).not.toContain("notes")
    }).pipe(Effect.ensuring(Effect.orDie(reEnableNotes))),
  )

  it.effect("metadata of a cube the caller cannot read is 404, like an unknown cube", () =>
    Effect.gen(function* () {
      const { base, token } = yield* asReader
      const metadata = (cube: string) => call(base, `/catalog/${cube}/metadata`, { token })
      expect((yield* metadata("notes")).status).toBe(200)
      expect((yield* metadata("permissions")).status).toBe(404)
      expect((yield* metadata("no-such-cube")).status).toBe(404)
    }),
  )

  it.effect("no response a reader can get carries a password hash", () =>
    Effect.gen(function* () {
      const admin = yield* asAdmin
      const note = yield* call(admin.base, "/notes", {
        method: "POST",
        token: admin.token,
        body: { title: "t", body: "b" },
      })
      const { base, token } = yield* asReader
      const noteId = (note.body as { id: string }).id
      for (const path of ["/account?limit=10", "/auth/me", `/links/Note/${noteId}`]) {
        expect(JSON.stringify((yield* call(base, path, { token })).body)).not.toMatch(HASH)
      }
    }),
  )
})
