// The install route's two error languages, over real HTTP (QWB-38).
//
// A CONTRACT refusal -- the installer refusing a package by its rules -- must reach the
// caller as a 400 carrying the refusal text: the message IS the contract, and rewriting it
// would hide what to fix. Anything else (a disk error, a bug) must become a 500 WITHOUT the
// message: a system error is the operator's log to read, not something a caller is shown.
//
// The seam that makes this one rule: `toInstallError` (kernel/install-parts.ts) keeps
// `InstallError` on the error channel and re-throws everything else as a defect; the
// settings handler maps `InstallError` to `BadRequest` and lets defects pass to the
// platform, which answers 500. This test exercises BOTH branches through the real router,
// the real handler and the real `tried` bridge -- only the installer itself is a fixture,
// because a real installer's IO failures depend on the machine, not on the code under test.
//
// Composed like capability-gates.test.ts: the real auth and permissions cubes issue the
// token and satisfy the Authorization middleware; only the store is in memory.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { HttpApiBuilder, HttpServer } from "@effect/platform"
import { type Context, Effect, Layer } from "effect"
import { cube as authCube } from "./cubes/auth/index.ts"
import { cube as permissionsCube } from "./cubes/permissions/index.ts"
import { cube as settingsCube } from "./cubes/settings/index.ts"
import type { MountedCube } from "./kernel/discovery.ts"
import { tried } from "./kernel/install-parts.ts"
import { InstallError } from "./kernel/manifest.ts"
import { Registry } from "./kernel/registry.ts"
import { buildApi, buildHandlers } from "./runtime-composition.ts"
import { memoryStore } from "./test-cube-tools.ts"

// The fixture installer speaks through the production bridge `tried`, so the branch the test
// proves is the branch production takes: an `InstallError` stays on the error channel; a raw
// throw becomes a defect the way a real EACCES would.
const contractRefusal = () =>
  tried(() => {
    throw new InstallError('refused: "bad-pkg" is already installed.')
  })
const diskFailure = () =>
  tried(() => {
    throw new Error("EACCES: permission denied, mkdir '/usr/local/lib/qwbe'")
  })

const installerFixture = {
  install: (name: string) => (name === "bad-pkg" ? contractRefusal() : diskFailure()),
  available: () => [],
  uninstallPackage: () => diskFailure(),
  cubeOnDisk: () => false,
  remove: () => diskFailure(),
  restart: () => {},
  scanDirectory: () => diskFailure(),
  forgetShelf: () => diskFailure(),
  stageAndInstall: () => diskFailure(),
}

const declared = new Map<string, ReadonlyArray<string>>([
  ["settings:read", ["admin", "reader"]],
  ["settings:write", ["admin"]],
])

const world = () => {
  const rolesOf = new Map<string, ReadonlyArray<string>>()
  const permissionsParts = permissionsCube.create({
    store: memoryStore(),
    bus: { publish: () => Effect.void },
    catalogue: () => [],
    permissions: () => declared,
    commands: () => [],
    identities: { resolveUsername: (username) => Effect.succeed({ id: username, username }) },
  })
  const service = permissionsParts.entityPermissions
  assert.ok(service)

  const auth = authCube.create({
    store: memoryStore(),
    bus: { publish: () => Effect.void },
    catalogue: () => [],
    permissions: () => declared,
    commands: () => [],
    credentials: {
      verify: (username) => Effect.succeed({ id: username, username, roles: rolesOf.get(username) ?? [] }),
    },
    entityPermissions: service,
  })

  const settings = settingsCube.create({
    store: memoryStore(),
    bus: { publish: () => Effect.void },
    catalogue: () => [],
    permissions: () => declared,
    commands: () => [],
    switches: { list: () => [], set: () => Effect.die("not exercised here") },
    installer: installerFixture,
    entityPermissions: service,
  })

  const registry = Layer.succeed(Registry, {
    summary: (_entity: string, id: string) =>
      Effect.succeed({
        id,
        title: id,
        details: [{ key: "roles", value: (rolesOf.get(id) ?? []).join(",") }],
      }),
  } as unknown as Context.Tag.Service<typeof Registry>)
  const authLive = Layer.provide(assertOk(auth.layers), registry)

  const cubes = [
    { manifest: authCube.manifest, name: "auth", parts: auth, plugin: null, commands: [] },
    { manifest: settingsCube.manifest, name: "settings", parts: settings, plugin: null, commands: [] },
  ] as unknown as ReadonlyArray<MountedCube>
  const api = buildApi(cubes)
  const webHandler = HttpApiBuilder.toWebHandler(
    Layer.mergeAll(
      HttpApiBuilder.api(api).pipe(
        Layer.provide(buildHandlers(api, cubes).pipe(Layer.provide(registry))),
        Layer.provide(authLive),
      ),
      HttpServer.layerContext,
    ),
  )

  const http = async (method: string, path: string, token?: string, body?: unknown) => {
    const response = await webHandler.handler(
      new Request(`http://qwbe.test${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    )
    const text = await response.text()
    return { status: response.status, body: text }
  }
  return { rolesOf, http, dispose: () => webHandler.dispose() }
}

function assertOk<T>(value: T | undefined): T {
  assert.ok(value)
  return value
}

describe("the install route speaks two languages -- contract refusal, system failure (QWB-38)", () => {
  // ONE world per process: `buildApi` widens the module-singleton groups IN PLACE (as boot
  // does), so a second composition in the same process fails with a duplicate index
  // signature. Both branches run through the same composed router.
  const w = world()
  w.rolesOf.set("root", ["admin"])

  it("a contract refusal is a 400 carrying the installer's own message", async () => {
    const login = await w.http("POST", "/auth/login", undefined, { username: "root", password: "" })
    assert.equal(login.status, 200)
    const body = JSON.parse(login.body) as { token: string }
    const response = await w.http("POST", "/settings/packages/bad-pkg/install", body.token)
    assert.equal(response.status, 400)
    assert.equal((JSON.parse(response.body) as { message: string }).message, 'refused: "bad-pkg" is already installed.')
  })

  it("a disk failure is a 500 that names nothing", async () => {
    const login = await w.http("POST", "/auth/login", undefined, { username: "root", password: "" })
    const body = JSON.parse(login.body) as { token: string }
    const response = await w.http("POST", "/settings/packages/io-pkg/install", body.token)
    assert.equal(response.status, 500)
    // The system error's text must not reach the caller in any shape.
    assert.ok(!response.body.includes("EACCES"))
    assert.ok(!response.body.includes("/usr/local/lib/qwbe"))
    await w.dispose()
  })
})
