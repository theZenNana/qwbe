// QWB-69: unit tests for the auth cube, run in memory (no Postgres, no kernel store build).
// Proves the cube's contract (manifest/routes/permissions) and the real login/logout behavior
// over an in-memory store: the only public endpoint is `login`, sessions are stored as hashes,
// wrong credentials are refused, and logout drops exactly the caller's own session.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Effect } from "effect"
import type { CubeTools } from "qwbe-core/cube"
import { CurrentUser } from "../../kernel/auth-contract.ts"
import { Unauthorized } from "../../kernel/errors.ts"
import { routeContracts } from "../../metadata/metadata.ts"
import { baseTools, memoryStore, recordingBus } from "../../test-cube-tools.ts"
import { cube } from "./index.ts"

// The routes the kernel actually publishes, derived the one way (entity-less cube: no field
// metadata, so deriveCubeMetadata never reaches the routes -- routeContracts is that derivation).
const md = routeContracts(
  cube.manifest.name,
  cube.create({ store: {}, bus: { publish: () => undefined as never } } as never).group,
  cube.manifest,
)

type LoginResult = { token: string; expiresAt: string }

const authTools = (): CubeTools => {
  const tools = baseTools() as Record<string, unknown>
  tools.credentials = {
    verify: (username: string) => Effect.succeed({ id: "acc-1", username }),
  }
  tools.entityPermissions = { capabilitiesFor: () => Effect.succeed([] as string[]) }
  return tools as unknown as CubeTools
}

const user = (sessionId: string, permissions: ReadonlyArray<string>) => ({
  id: "acc-1",
  username: "ana",
  roles: ["reader"],
  permissions,
  sessionId,
})

describe("auth cube contract (QWB-69)", () => {
  it("publishes login/me/logout through the kernel's one route derivation", () => {
    assert.equal(cube.manifest.name, "auth")
    assert.equal(cube.manifest.requiresAuth, false)
    assert.deepEqual(cube.manifest.tables, ["sessions"])
    assert.deepEqual(cube.manifest.permissions, [{ name: "auth:session", roles: ["admin", "reader"] }])
    // login is public; me/logout are explicitly per-request (null permission), both behind auth.
    assert.deepEqual(md, {
      login: { auth: false, permission: null, method: "POST", path: "/auth/login" },
      me: { auth: true, permission: null, method: "GET", path: "/auth/me" },
      logout: { auth: true, permission: null, method: "POST", path: "/auth/logout" },
    })
  })

  it("refuses login when the credentials capability verifies nothing", async () => {
    // The negative branch: with no identity returned, login must fail with Unauthorized.
    const tools = authTools() as Record<string, unknown>
    tools.credentials = { verify: () => Effect.succeed(undefined) }
    const failing = (
      cube.create(tools as unknown as CubeTools).handlers.login as (a: {
        payload: { username: string; password: string }
      }) => Effect.Effect<LoginResult, Unauthorized>
    )({ payload: { username: "ghost", password: "x" } })
    const err = await Effect.runPromise(Effect.flip(failing))
    assert.ok(err instanceof Unauthorized)
    assert.equal(err.message, "wrong username or password")
  })

  it("issues a token, stores only its hash, and records the login event", async () => {
    const bus = recordingBus()
    const tools = authTools() as Record<string, unknown>
    tools.bus = bus
    const store = memoryStore()
    tools.store = store
    const ok = (await Effect.runPromise(
      (
        cube.create(tools as unknown as CubeTools).handlers.login as (a: {
          payload: { username: string; password: string }
        }) => Effect.Effect<LoginResult, Unauthorized>
      )({ payload: { username: "ana", password: "pw" } }),
    )) as LoginResult

    // Token is opaque base64url of 32 bytes, and the raw token is never stored.
    assert.equal(ok.token.length, 43)
    const rows = (await Effect.runPromise(store.all<Record<string, unknown>>("sessions"))) as ReadonlyArray<
      Record<string, unknown>
    >
    assert.equal(rows.length, 1)
    assert.ok(!("token" in rows[0]!))
    assert.ok(typeof rows[0]!.tokenHash === "string")
    assert.equal(bus.events[0]?.topic, "auth.loggedIn")
  })

  it("drops exactly the caller's own session on logout", async () => {
    const store = memoryStore()
    const bus = recordingBus()
    const tools = authTools() as Record<string, unknown>
    tools.store = store
    tools.bus = bus
    const p = cube.create(tools as unknown as CubeTools)
    // Two sessions of the same account, as a second device would create.
    await Effect.runPromise(
      store.insert("sessions", "Session", "ses", {
        accountId: "acc-1",
        tokenHash: "a",
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      }),
    )
    await Effect.runPromise(
      store.insert("sessions", "Session", "ses", {
        accountId: "acc-1",
        tokenHash: "b",
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      }),
    )
    const logout = p.handlers.logout as () => Effect.Effect<{ ok: boolean }, never, CurrentUser>
    await Effect.runPromise(Effect.provideService(logout(), CurrentUser, user("ses-1", [])))
    const rows = (await Effect.runPromise(store.all<Record<string, unknown>>("sessions"))) as ReadonlyArray<{
      id: string
      deleted: boolean
    }>
    // Only the session carried by the middleware is soft-deleted; the other device survives.
    assert.deepEqual(
      rows.map((r) => ({ id: r.id, deleted: r.deleted })),
      [
        { id: "ses-1", deleted: true },
        { id: "ses-2", deleted: false },
      ],
    )
    assert.equal(bus.events[0]?.topic, "auth.loggedOut")
  })
})
