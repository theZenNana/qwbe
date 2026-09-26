import * as NodeContext from "@effect/platform-node/NodeContext"
import { expect, layer } from "@effect/vitest"
import * as Console from "effect/Console"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { call, login } from "../_layers/api-client.ts"
import { boot, USERS } from "../_layers/boot.ts"
import { PKG, PKG_CUBE, plantPackage } from "../_layers/pack-copy.ts"
import { Workspace, workspace } from "../_layers/workspace.ts"

// A package goes from the shelf into a running system and back out, across three boots over the
// same database and directories. Install and uninstall only take effect at the next boot.

const mountedCubes = (base: string, token: string) =>
  call(base, "/settings/cubes", { token }).pipe(
    Effect.map((reply) => (reply.body as ReadonlyArray<{ name: string }>).map((cube) => cube.name)),
  )

const status = (base: string, path: string, token: string) =>
  call(base, path, { token }).pipe(Effect.map((reply) => reply.status))

/** One boot for the length of `step`, its time to answer printed as the benchmark line. */
const booted = <A, E, R>(label: string, step: (base: string, token: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const [elapsed, base] = yield* Effect.timed(boot())
      yield* Console.log(`bench package-lifecycle ${label}: ready in ${Math.round(Duration.toMillis(elapsed))} ms`)
      return yield* step(base, yield* login(base, "admin", USERS.admin))
    }),
  )

const install = (base: string, token: string) =>
  Effect.gen(function* () {
    expect(yield* status(base, `/${PKG_CUBE}`, token)).toBe(404)
    const installed = yield* call(base, `/settings/packages/${PKG}/install`, { method: "POST", token })
    expect([installed.status, (installed.body as { requiresRestart?: boolean }).requiresRestart]).toEqual([200, true])
    expect(yield* status(base, `/${PKG_CUBE}`, token)).toBe(404)
  })

const useThenUninstall = (base: string, token: string) =>
  Effect.gen(function* () {
    expect(yield* mountedCubes(base, token)).toContain(PKG_CUBE)
    const row = { label: "Proba", targetCube: "notes", url: "https://example.org/proba" }
    expect((yield* call(base, `/${PKG_CUBE}`, { method: "POST", token, body: row })).status).toBe(200)
    const removed = yield* call(base, `/settings/packages/${PKG}`, { method: "DELETE", token })
    expect([removed.status, (removed.body as { requiresRestart?: boolean }).requiresRestart]).toEqual([200, true])
    expect(yield* status(base, `/${PKG_CUBE}`, token)).toBe(200)
  })

const gone = (base: string, token: string) =>
  Effect.gen(function* () {
    expect(yield* status(base, `/${PKG_CUBE}`, token)).toBe(404)
    expect(yield* mountedCubes(base, token)).not.toContain(PKG_CUBE)
  })

layer(workspace("lifecycle").pipe(Layer.provideMerge(NodeContext.layer)), {
  timeout: 120_000,
  excludeTestServices: true,
})((it) => {
  it.effect("installs, mounts after a restart, uninstalls, and is gone after the next restart", () =>
    Effect.gen(function* () {
      yield* plantPackage((yield* Workspace).storeDir)
      yield* booted("boot 1", install)
      yield* booted("boot 2", useThenUninstall)
      yield* booted("boot 3", gone)
    }),
  )
})
