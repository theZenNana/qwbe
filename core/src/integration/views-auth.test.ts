// QWB-62: in-memory authorization regression for the views cube, over the REAL router and the
// REAL gates exactly as mount composes them (route gate `withDeclaredPermission` outside the
// entity gate `enforceEntityHandlers`, both applied by `buildHandlers`). Same shape as
// capability-gates.test.ts: real auth cube (login issues a token, `bearer` builds
// `CurrentUser.permissions`), real permissions cube behind both gates, real views handlers --
// only the store is in memory; Postgres is the one part not exercised here.
//
// The walk proven here: a reader creates a private view, another reader cannot read/edit/delete
// it, an explicit READ grant allows read but not edit/delete/reshare, revoking the grant removes
// access, and the route capability stays independent of the entity grant in BOTH directions.
// No target-data escalation is possible by construction: a view is an opaque config DOCUMENT and
// the manifest publishes no route that executes it (asserted below), so a grant can leak only
// the shortcut parameters, never a row of the target cube.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { HttpApiBuilder, HttpServer } from "@effect/platform"
import type { Context } from "effect"
import { Effect, Layer } from "effect"
import type { CubeTools } from "qwbe-core/cube"
import { cube as authCube } from "../cubes/auth/index.ts"
import { cube as permissionsCube } from "../cubes/permissions/index.ts"
import { cube as viewsCube } from "../cubes/views/index.ts"
import { enforceEntityHandlers } from "../entity-enforcement.ts"
import type { MountedCube } from "../kernel/discovery.ts"
import { Registry } from "../kernel/registry.ts"
import { buildApi, buildHandlers } from "../runtime-composition.ts"
import { memoryStore } from "../test-cube-tools.ts"

// One world per process: `buildApi` widens the module-singleton views group IN PLACE (as boot
// does, once), so a second composition would fail the entity contract. Everything below runs
// over this one router.
const rolesOf = new Map<string, ReadonlyArray<string>>()

const world = () => {
  const store = memoryStore()
  const declared = new Map<string, ReadonlyArray<string>>(
    viewsCube.manifest.permissions?.map((p) => [p.name, p.roles as ReadonlyArray<string>]) ?? [],
  )
  const permissionsParts = permissionsCube.create({
    store,
    bus: { publish: () => Effect.void },
    catalogue: () => [],
    permissions: () => declared,
    commands: () => [],
    identities: { resolveUsername: (username) => Effect.succeed({ id: username, username }) },
  })
  const service = permissionsParts.entityPermissions
  assert.ok(service)
  const viewsParts = viewsCube.create({ store } as CubeTools)
  const group = viewsParts.group
  const entityGated = enforceEntityHandlers("views", "SavedView", group, viewsParts.handlers, service)
  const mounted = {
    manifest: viewsCube.manifest,
    name: "views",
    parts: { group, handlers: entityGated },
  } as unknown as MountedCube
  // The real auth cube; the password is not checked, accounts are whatever `rolesOf` says.
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
  const registry = Layer.succeed(Registry, {
    summary: (_entity: string, id: string) =>
      Effect.succeed({ id, title: id, details: [{ key: "roles", value: (rolesOf.get(id) ?? []).join(",") }] }),
  } as unknown as Context.Tag.Service<typeof Registry>)
  assert.ok(auth.layers)
  const authLive = Layer.provide(auth.layers, registry)
  const cubes = [
    { manifest: authCube.manifest, name: "auth", parts: auth, plugin: null, commands: [] },
    { manifest: permissionsCube.manifest, name: "permissions", parts: permissionsParts, plugin: null, commands: [] },
    mounted,
  ] as unknown as ReadonlyArray<MountedCube>
  const api = buildApi(cubes)
  const ApiLive = HttpApiBuilder.api(api).pipe(
    Layer.provide(buildHandlers(api, cubes).pipe(Layer.provide(registry))),
    Layer.provide(authLive),
  )
  const web = HttpApiBuilder.toWebHandler(Layer.mergeAll(ApiLive, HttpServer.layerContext))
  const http = async (method: string, path: string, token?: string, body?: unknown) => {
    const response = await web.handler(
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
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null }
  }
  const token = async (userId: string, roles: ReadonlyArray<string>) => {
    rolesOf.set(userId, roles)
    const login = await http("POST", "/auth/login", undefined, { username: userId, password: "" })
    assert.equal(login.status, 200)
    return (login.body as { token: string }).token
  }
  return { service, http, token, dispose: () => web.dispose() }
}

const grantPath = (id: string) => `/permissions/entities/views/SavedView/${id}/grants/user`
const listRequest = "/views?offset=0&limit=10"

describe("views authorization over the real router (QWB-62)", () => {
  it("private view, read grant without reshare, revoke, and the two gates stay separate", async () => {
    const w = world()
    const owner = await w.token("ovidiu", ["reader"])
    const other = await w.token("ana", ["reader"])
    const needed = async (response: { status: number; body: Record<string, unknown> | null }) => {
      assert.equal(response.status, 403)
      return response.body?.needed
    }

    // The published contract has no route that executes a view: a grant can never leak rows.
    assert.deepEqual(Object.keys(viewsCube.manifest.routes as Record<string, string>), [
      "list",
      "get",
      "create",
      "update",
      "remove",
    ])

    // An ordinary reader creates a private view; ownership is claimed by the entity wrapper.
    const created = await w.http("POST", "/views", owner, {
      targetCube: "crm/organizations",
      name: "Mine",
      config: { columns: ["name"], filters: { status: "open" } },
    })
    assert.equal(created.status, 200)
    const id = created.body?.id as string
    assert.ok(id)
    assert.equal(created.body?.updatedBy, "ovidiu")
    assert.equal((created.body as { ownerId?: string }).ownerId, undefined, "no denormalized owner column")

    // The list is row-filtered: only the owner sees the view.
    const ownerList = await w.http("GET", listRequest, owner)
    assert.equal(ownerList.status, 200)
    assert.deepEqual([(ownerList.body?.rows as unknown[] | undefined)?.length, ownerList.body?.total], [1, 1])
    const otherList = await w.http("GET", listRequest, other)
    assert.deepEqual([(otherList.body?.rows as unknown[] | undefined)?.length, otherList.body?.total], [0, 0])

    // The other reader cannot read, edit or delete it.
    assert.equal(await needed(await w.http("GET", `/views/${id}`, other)), "views:entity")
    assert.equal(await needed(await w.http("PATCH", `/views/${id}`, other, { name: "Stolen" })), "views:entity")
    assert.equal(await needed(await w.http("DELETE", `/views/${id}`, other)), "views:entity")

    // An explicit READ grant (share action withheld) allows read, nothing else.
    const grant = await w.http("POST", grantPath(id), owner, { username: "ana", actions: ["read"] })
    assert.equal(grant.status, 200)
    assert.deepEqual(grant.body?.actions, ["read"])
    const read = await w.http("GET", `/views/${id}`, other)
    assert.equal(read.status, 200)
    assert.equal(read.body?.name, "Mine")
    // The read grant exposes the opaque config DOCUMENT, never data of the target cube.
    assert.deepEqual(JSON.parse(read.body?.config as string), { columns: ["name"], filters: { status: "open" } })
    assert.equal(await needed(await w.http("PATCH", `/views/${id}`, other, { name: "Stolen" })), "views:entity")
    assert.equal(await needed(await w.http("DELETE", `/views/${id}`, other)), "views:entity")
    // The read grantee cannot reshare (no share action) and cannot revoke the grant either.
    assert.equal((await w.http("POST", grantPath(id), other, { username: "carmen", actions: ["read"] })).status, 403)
    assert.equal((await w.http("DELETE", `/permissions/grants/${grant.body?.id}`, other)).status, 403)

    // Revoking the grant removes the access on the next request.
    assert.equal((await w.http("DELETE", `/permissions/grants/${grant.body?.id}`, owner)).status, 200)
    assert.equal(await needed(await w.http("GET", `/views/${id}`, other)), "views:entity")

    // The route capability and the entity grant are two gates, in BOTH directions.
    // (a) entity grant without views:read -> the ROUTE gate stops the request first.
    const silent = await w.http("POST", grantPath(id), owner, { username: "carmen", actions: ["read"] })
    assert.equal(silent.status, 200)
    assert.equal(await needed(await w.http("GET", `/views/${id}`, await w.token("carmen", []))), "views:read")
    // (b) views:read capability without any entity grant -> the route passes, the list is
    // filtered to nothing and the item route is stopped by the ENTITY gate.
    const root = await w.token("root", ["admin"])
    const cap = await w.http("POST", "/permissions/capabilities/user", root, {
      capability: "views:read",
      username: "eve",
    })
    assert.equal(cap.status, 200)
    const eve = await w.token("eve", [])
    const eveList = await w.http("GET", listRequest, eve)
    assert.deepEqual([(eveList.body?.rows as unknown[] | undefined)?.length, eveList.body?.total], [0, 0])
    assert.equal(await needed(await w.http("GET", `/views/${id}`, eve)), "views:entity")
    await w.dispose()
  })
})
