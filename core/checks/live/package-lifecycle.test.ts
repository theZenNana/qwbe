import { expect, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { call, login } from "../_layers/api-client.ts"
import { boot, USERS } from "../_layers/boot.ts"
import { PKG, PKG_CUBE, plantBookmarksCopy } from "../_layers/pack-copy.ts"
import { testWorkspace } from "../_layers/test-server.ts"
import { Workspace } from "../_layers/workspace.ts"

// Replaces probes/lifecycle.mjs, lifecycle-life.mjs and install-from-life.mjs: a package goes
// from the shelf into a running system and back out across three boots over the same database
// and directories. Install and uninstall take effect only at the next boot.

const Cubes = Schema.Array(Schema.Struct({ name: Schema.String }))
const Packages = Schema.Array(Schema.Struct({ name: Schema.String, installed: Schema.Boolean }))
const Changed = Schema.Struct({ requiresRestart: Schema.Literal(true) })

const statusOf = (base: string, token: string, path: string) =>
  Effect.map(call(base, path, { token }), (reply) => reply.status)

const mounted = (base: string, token: string) =>
  call(base, "/settings/cubes", { token }).pipe(
    Effect.flatMap((reply) => Schema.decodeUnknown(Cubes)(reply.body)),
    Effect.map((cubes) => cubes.map(({ name }) => name)),
  )

const installedFlag = (base: string, token: string) =>
  call(base, "/settings/packages", { token }).pipe(
    Effect.flatMap((reply) => Schema.decodeUnknown(Packages)(reply.body)),
    Effect.map((shelf) => shelf.find(({ name }) => name === PKG)?.installed),
  )

// 200 with requiresRestart: true, or the test fails naming what came back.
const changePackage = (base: string, token: string, method: "POST" | "DELETE", path: string) =>
  call(base, path, { method, token }).pipe(
    Effect.filterOrDie(
      (reply) => reply.status === 200 && Schema.is(Changed)(reply.body),
      (reply) => new Error(`${method} ${path} answered ${reply.status} ${JSON.stringify(reply.body)}`),
    ),
  )

const install = (base: string, token: string) => changePackage(base, token, "POST", `/settings/packages/${PKG}/install`)
const uninstall = (base: string, token: string) => changePackage(base, token, "DELETE", `/settings/packages/${PKG}`)

/** One boot for the length of `step`, logged in as admin; the server stops when it ends. */
const booted = <A, E, R>(step: (base: string, token: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.flatMap(boot(), (base) => Effect.flatMap(login(base, "admin", USERS.admin), (token) => step(base, token))),
  )

// Installed on disk, not mounted yet: the drift the settings screen shows until the restart.
const installPending = (base: string, token: string) =>
  Effect.gen(function* () {
    yield* install(base, token)
    expect(yield* installedFlag(base, token)).toBe(true)
    expect(yield* mounted(base, token)).not.toContain(PKG_CUBE)
    expect(yield* statusOf(base, token, `/${PKG_CUBE}`)).toBe(404)
  })

// Mounted and writable; uninstalled it keeps answering until the restart, and the kept shelf
// lets it come back and go again without a source directory.
const useThenRemove = (base: string, token: string) =>
  Effect.gen(function* () {
    expect(yield* mounted(base, token)).toContain(PKG_CUBE)
    const row = { label: "Proba", targetCube: "notes", url: "https://example.org/proba" }
    expect((yield* call(base, `/${PKG_CUBE}`, { method: "POST", token, body: row })).status).toBe(200)
    yield* uninstall(base, token)
    expect(yield* statusOf(base, token, `/${PKG_CUBE}`)).toBe(200)
    yield* install(base, token)
    yield* uninstall(base, token)
    expect(yield* statusOf(base, token, "/auth/me")).toBe(200)
  })

const gone = (base: string, token: string) =>
  Effect.gen(function* () {
    expect(yield* statusOf(base, token, `/${PKG_CUBE}`)).toBe(404)
    expect(yield* mounted(base, token)).not.toContain(PKG_CUBE)
  })

layer(testWorkspace("lifecycle"), { timeout: 120_000, excludeTestServices: true })((it) => {
  it.effect("installs, mounts after a restart, uninstalls, and is gone after the next restart", () =>
    Effect.gen(function* () {
      yield* plantBookmarksCopy((yield* Workspace).storeDir)
      yield* booted(installPending)
      yield* booted(useThenRemove)
      yield* booted(gone)
    }),
  )
})
