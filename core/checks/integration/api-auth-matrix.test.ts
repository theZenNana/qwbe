import { expect, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Unauthorized } from "../../src/kernel/errors.ts"
import { call, login } from "../_layers/api-client.ts"
import { TestServer, testServer } from "../_layers/test-server.ts"

// Ported from probes/contract.mjs (anonymous 401 matrix), probes/security.mjs (tokens, switched-off
// cube), probes/security-injection.mjs (no hash) and probes/cube-metadata.mjs (404 without permission).

const METHODS = ["get", "post", "put", "patch", "delete"]
const HASH = /passwordHash|[a-f0-9]{64}/

type Paths = Readonly<Record<string, Readonly<Record<string, unknown>>>>

/** "METHOD /path" for every published operation except login, path parameters filled with a placeholder. */
const protectedRoutes = (paths: Paths): ReadonlyArray<readonly [string, string]> =>
  Object.entries(paths).flatMap(([path, item]) =>
    Object.keys(item)
      .filter((method) => METHODS.includes(method) && !(method === "post" && path === "/auth/login"))
      .map((method) => [method.toUpperCase(), path.replaceAll(/\{[^}]+\}/g, "check-missing")] as const),
  )

const isDeclared401 = (status: number, body: unknown) =>
  status === 401 && Option.isSome(Schema.decodeUnknownOption(Unauthorized)(body))

/** Authentication runs before payload decoding, so an empty object is an inert body for every mutation. */
const anonymous = (base: string, method: string, path: string) =>
  call(base, path, { method, ...(method === "GET" || method === "DELETE" ? {} : { body: {} }) })

const switchCube = (base: string, token: string, cube: string, enabled: boolean) =>
  call(base, `/settings/cubes/${cube}`, { method: "POST", token, body: { enabled } })

layer(testServer("authmatrix"), { timeout: 60_000, excludeTestServices: true })((it) => {
  it.effect("every protected route answers an anonymous caller with its declared 401", () =>
    Effect.gen(function* () {
      const { base } = yield* TestServer
      const spec = yield* call(base, "/openapi.json", { token: yield* login(base, "admin", "admin") })
      const routes = protectedRoutes((spec.body as { paths: Paths }).paths)
      const replies = yield* Effect.forEach(routes, ([method, path]) => anonymous(base, method, path))
      const wrong = routes.filter((_, i) => !isDeclared401(replies[i]!.status, replies[i]!.body))
      expect(routes.length).toBeGreaterThan(0)
      expect(wrong).toEqual([])
    }),
  )

  it.effect("a forged, empty or scheme-less token is 401", () =>
    Effect.gen(function* () {
      const { base } = yield* TestServer
      const token = yield* login(base, "admin", "admin")
      for (const authorization of [`Bearer ${"a".repeat(43)}`, "Bearer ", token]) {
        expect((yield* call(base, "/auth/me", { headers: { authorization } })).status).toBe(401)
      }
    }),
  )

  it.effect("a switched-off cube looks exactly like a missing one", () =>
    Effect.gen(function* () {
      const { base } = yield* TestServer
      const token = yield* login(base, "admin", "admin")
      yield* switchCube(base, token, "notes", false)
      const [off, missing] = yield* Effect.all([call(base, "/notes"), call(base, "/nosuchcube")])
      expect((yield* call(base, "/notes?limit=1", { token })).status).toBe(404)
      expect(off.body).toEqual(missing.body)
      const command = yield* call(base, "/cli/exec", { method: "POST", token, body: { line: "notes:count" } })
      expect(command.status).toBe(400)
    }).pipe(Effect.ensuring(TestServer.pipe(Effect.flatMap(({ base }) => reEnableNotes(base))))),
  )

  it.effect("metadata of a cube the caller cannot read is 404, like an unknown cube", () =>
    Effect.gen(function* () {
      const { base } = yield* TestServer
      const token = yield* login(base, "reader", "reader")
      const metadata = (cube: string) => call(base, `/catalog/${cube}/metadata`, { token })
      expect((yield* metadata("notes")).status).toBe(200)
      expect((yield* metadata("permissions")).status).toBe(404)
      expect((yield* metadata("no-such-cube")).status).toBe(404)
    }),
  )

  it.effect("no response a reader can get carries a password hash", () =>
    Effect.gen(function* () {
      const { base } = yield* TestServer
      const admin = yield* login(base, "admin", "admin")
      const note = yield* call(base, "/notes", { method: "POST", token: admin, body: { title: "t", body: "b" } })
      const token = yield* login(base, "reader", "reader")
      const noteId = (note.body as { id: string }).id
      for (const path of ["/account?limit=10", "/auth/me", `/links/Note/${noteId}`]) {
        expect(JSON.stringify((yield* call(base, path, { token })).body)).not.toMatch(HASH)
      }
    }),
  )
})

const reEnableNotes = (base: string) =>
  login(base, "admin", "admin").pipe(Effect.flatMap((token) => switchCube(base, token, "notes", true)))
