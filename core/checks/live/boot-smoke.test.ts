import { expect, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { call } from "../../src/api-client.ts"
import { asAdmin, type Session, sessionAs } from "../_layers/session.ts"
import { TestServer, testServer } from "../_layers/test-server.ts"

// Replaces probes/smoke.mjs, smoke-cli.mjs (the switch), store.mjs, part 3 of agent-surface.mjs
// and the QWBE_MOUNTED half of decoupling-removal.mjs. The one check that boots core/src/main.ts
// from login to logout; the rules behind each route live in the unit and integration checks.

const SERVER = { timeout: 60_000, excludeTestServices: true } as const

const BASE_CUBES = [
  "account",
  "auth",
  "catalog",
  "cli",
  "customfields",
  "echo",
  "links",
  "notes",
  "permissions",
  "settings",
  "staging",
  "views",
]

const Cubes = Schema.Array(Schema.Struct({ name: Schema.String, agent: Schema.Boolean }))
const Me = Schema.Struct({ permissions: Schema.Array(Schema.String) })

const cubes = (admin: Session) =>
  admin.get("/settings/cubes").pipe(Effect.flatMap((reply) => Schema.decodeUnknown(Cubes)(reply.body)))

const permissions = (admin: Session) =>
  admin.get("/auth/me").pipe(
    Effect.flatMap((reply) => Schema.decodeUnknown(Me)(reply.body)),
    Effect.map((me) => me.permissions),
  )

layer(
  testServer("boot"),
  SERVER,
)((it) => {
  it.effect("refuses a wrong password and no token, and hands out an opaque token", () =>
    Effect.gen(function* () {
      const { base } = yield* TestServer
      const wrong = yield* call(base, "/auth/login", { method: "POST", body: { username: "admin", password: "x" } })
      const anonymous = yield* call(base, "/notes")
      expect([wrong.status, anonymous.status]).toEqual([401, 401])
      expect((yield* sessionAs(base, "admin")).token).not.toContain(".")
    }),
  )

  it.effect("mounts every base cube and no agent when the plugins directory is empty", () =>
    Effect.gen(function* () {
      const admin = yield* asAdmin
      const mounted = yield* cubes(admin)
      expect(mounted.map(({ name }) => name).toSorted()).toEqual(BASE_CUBES)
      expect(mounted.filter(({ agent }) => agent)).toEqual([])
      for (const path of ["/auth/me", "/account?limit=5", "/notes?limit=1", "/cli/commands"]) {
        expect([path, yield* admin.status(path)]).toEqual([path, 200])
      }
    }),
  )

  it.effect("answers the empty package shelf with 200 and an empty list", () =>
    Effect.gen(function* () {
      const shelf = yield* (yield* asAdmin).get("/settings/packages")
      expect([shelf.status, shelf.body]).toEqual([200, []])
    }),
  )

  it.effect("switches a cube off and on, and refuses to switch off a required one", () =>
    Effect.gen(function* () {
      const admin = yield* asAdmin
      yield* admin.switchCube("notes", false)
      const off = yield* admin.status("/notes?limit=1")
      const required = yield* admin.switchCube("settings", false)
      yield* admin.switchCube("notes", true)
      expect([off, required.status, yield* admin.status("/notes?limit=1")]).toEqual([404, 400, 200])
    }),
  )

  it.effect("revokes the token on logout", () =>
    Effect.gen(function* () {
      const admin = yield* asAdmin
      const out = yield* admin.send("POST", "/auth/logout")
      expect([out.status, yield* admin.status("/auth/me")]).toEqual([200, 401])
    }),
  )
})

layer(
  testServer("boot-no-notes", { QWBE_MOUNTED: BASE_CUBES.filter((name) => name !== "notes").join(",") }),
  SERVER,
)((it) => {
  it.effect("boots without the notes cube: its routes and permissions are simply absent", () =>
    Effect.gen(function* () {
      const admin = yield* asAdmin
      expect(yield* admin.status("/notes?limit=1")).toBe(404)
      expect((yield* permissions(admin)).filter((name) => name.startsWith("notes:"))).toEqual([])
    }),
  )
})
