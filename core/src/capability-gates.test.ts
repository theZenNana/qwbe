// QWB-63: runtime cube capability grants, proven against the two REAL gates composed the way
// mount composes them -- `withDeclaredPermission` (route) outside `enforceEntityHandlers`
// (entity) -- with the real permissions cube behind both, and the REAL auth cube resolving the
// caller: login issues a session, `Authorization.bearer` builds `CurrentUser.permissions` the
// way every request does (role permissions plus runtime grants). Only the store, the registry
// and the credential check are in memory.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, HttpServer } from "@effect/platform"
import { Cause, type Context, Effect, Exit, Layer, Logger, LogLevel, Redacted, Schema } from "effect"
import type { CubeTools } from "qwbe-core/cube"
import { PermissionForbidden, PermissionInvalid, PermissionNotFound } from "qwbe-core/permissions"
import { cube as authCube } from "./cubes/auth/index.ts"
import { cube as permissionsCube } from "./cubes/permissions/index.ts"
import { enforceEntityHandlers } from "./entity-enforcement.ts"
import { Authorization, CurrentUser } from "./kernel/auth-contract.ts"
import type { MountedCube } from "./kernel/discovery.ts"
import { Forbidden } from "./kernel/errors.ts"
import { ListParams } from "./kernel/list.ts"
import { Registry } from "./kernel/registry.ts"
import { buildApi, buildHandlers, withDeclaredPermission } from "./runtime-composition.ts"

const memoryStore = (): CubeTools["store"] => {
  const tables = new Map<string, Array<Record<string, unknown>>>()
  let next = 0
  const rows = (table: string) => {
    const found = tables.get(table)
    if (found) return found
    const created: Array<Record<string, unknown>> = []
    tables.set(table, created)
    return created
  }
  return {
    all: <A>(table: string) => Effect.succeed(rows(table) as ReadonlyArray<A>),
    page: <A>(table: string, page: { offset: number; limit: number }, where?: unknown) => {
      // One-pair filter only: what the auth cube's token lookup uses.
      const pair = where as { field: string; value: unknown } | undefined
      const hit = pair && "field" in pair ? rows(table).filter((row) => row[pair.field] === pair.value) : rows(table)
      return Effect.succeed({
        rows: hit.slice(page.offset, page.offset + page.limit) as ReadonlyArray<A>,
        total: hit.length,
        offset: page.offset,
        limit: page.limit,
        sortedBy: "createdAt",
      })
    },
    byId: <A>(table: string, id: string) => Effect.succeed(rows(table).find((row) => row.id === id) as A | undefined),
    insert: (table: string, type: string, prefix: string, values: Record<string, unknown>) =>
      Effect.sync(() => {
        const row = { id: `${prefix}-${++next}`, type, createdAt: new Date().toISOString(), deleted: false, ...values }
        rows(table).push(row)
        return row
      }),
    update: (table: string, id: string, patch: Record<string, unknown>) =>
      Effect.sync(() => {
        const row = rows(table).find((candidate) => candidate.id === id)
        if (!row) return undefined
        Object.assign(row, patch)
        return row
      }),
    count: (table: string) => Effect.succeed(rows(table).length),
  }
}

// The declared permissions of the whole system, as the kernel aggregates them from manifests.
const declared = new Map<string, ReadonlyArray<string>>([
  ["fixture:read", ["admin", "reader"]],
  ["fixture:write", ["admin"]],
  ["other:write", ["admin"]],
])
const manifest = {
  name: "fixture",
  entity: "Thing",
  routes: { list: "fixture:read", get: "fixture:read", create: "fixture:write", update: "fixture:write" },
}
const Row = Schema.Struct({ id: Schema.String, title: Schema.String })
const Page = Schema.Struct({
  rows: Schema.Array(Row),
  total: Schema.Number,
  offset: Schema.Number,
  limit: Schema.Number,
  sortedBy: Schema.String,
})
// Built per world: `buildApi` widens the endpoint schemas IN PLACE (as it does at boot, once),
// so a shared group would reach the second test already widened and fail the entity contract.
const fixtureGroup = () =>
  HttpApiGroup.make("fixture")
    .add(HttpApiEndpoint.get("list")`/fixture`.setUrlParams(ListParams).addSuccess(Page).addError(Forbidden))
    .add(
      HttpApiEndpoint.get("get")`/fixture/${HttpApiSchema.param("id", Schema.String)}`
        .addSuccess(Row)
        .addError(Forbidden),
    )
    .add(HttpApiEndpoint.post("create")`/fixture`.setPayload(Row).addSuccess(Row).addError(Forbidden))
    .add(
      HttpApiEndpoint.patch("update")`/fixture/${HttpApiSchema.param("id", Schema.String)}`
        .setPayload(Row)
        .addSuccess(Row)
        .addError(Forbidden),
    )
    .middleware(Authorization)

// `declaredNow` is what the kernel aggregates NOW; a test may hand in a mutable copy to unmount a cube.
const world = (declaredNow: ReadonlyMap<string, ReadonlyArray<string>> = declared, store = memoryStore()) => {
  const permissionsParts = permissionsCube.create({
    store,
    bus: { publish: () => Effect.void },
    catalogue: () => [],
    permissions: () => declaredNow,
    commands: () => [],
    identities: { resolveUsername: (username) => Effect.succeed({ id: username, username }) },
  })
  const service = permissionsParts.entityPermissions
  assert.ok(service)
  const things = [
    { id: "t1", title: "one" },
    { id: "t2", title: "two" },
    { id: "t3", title: "three" },
  ]
  const ran: Array<string> = []
  const raw = {
    list: () => Effect.succeed({ rows: things, total: things.length, offset: 0, limit: things.length, sortedBy: "id" }),
    get: ({ path }: { path: { id: string } }) => Effect.succeed(things.find((row) => row.id === path.id)),
    create: () =>
      Effect.sync(() => {
        ran.push("create")
        return { id: "t-new", title: "new" }
      }),
    update: ({ path }: { path: { id: string } }) =>
      Effect.sync(() => {
        ran.push("update")
        return { id: path.id, title: "x" }
      }),
  }
  const group = fixtureGroup()
  const entityGated = enforceEntityHandlers("fixture", "Thing", group, raw, service)
  const mounted = { manifest, name: "fixture", parts: { group, handlers: entityGated } } as unknown as MountedCube
  const handlers = Object.fromEntries(
    Object.keys(raw).map((name) => [
      name,
      withDeclaredPermission(mounted, name, entityGated[name as keyof typeof raw]),
    ]),
  ) as Record<keyof typeof raw, (request: unknown) => Effect.Effect<unknown, unknown, CurrentUser>>
  // The real auth cube. Accounts are whatever `rolesOf` says; the password is not checked.
  const rolesOf = new Map<string, ReadonlyArray<string>>()
  const auth = authCube.create({
    store: memoryStore(),
    bus: { publish: () => Effect.void },
    catalogue: () => [],
    permissions: () => declaredNow,
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
  // The HttpApi handler type carries the request; the login handler never reads it.
  const login = auth.handlers.login as unknown as (r: {
    payload: { username: string; password: string }
  }) => Effect.Effect<{ token: string }, never, never>
  // What a request sees: a fresh login, then the middleware's own `bearer` on that token.
  const currentUser = (userId: string, roles: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      rolesOf.set(userId, roles)
      const { token } = yield* login({ payload: { username: userId, password: "" } })
      return yield* (yield* Authorization).bearer(Redacted.make(token))
    }).pipe(Effect.provide(authLive), Logger.withMinimumLogLevel(LogLevel.Warning)) as Effect.Effect<
      CurrentUser["Type"],
      unknown,
      never // the middleware TYPE names HttpServerRequest; `bearer` never reads it
    >
  const effective = (userId: string, roles: ReadonlyArray<string>) =>
    Effect.map(currentUser(userId, roles), (user) => user.permissions)
  const call = (userId: string, roles: ReadonlyArray<string>, name: keyof typeof raw, request: unknown) =>
    Effect.flatMap(currentUser(userId, roles), (user) =>
      handlers[name](request).pipe(Effect.provideService(CurrentUser, user)),
    )
  const failure = async (effect: Effect.Effect<unknown, unknown, never>) => {
    const exit = await Effect.runPromiseExit(effect)
    return Exit.isSuccess(exit) ? null : ((Array.from(Cause.failures(exit.cause))[0] as { needed?: string }) ?? null)
  }
  // The HTTP surface, composed by the kernel's own `buildApi` / `buildHandlers` over the same
  // three cubes: the real router, the real `Authorization` middleware from the auth cube's
  // layer, the real permissions endpoints (schemas, error mapping), the route gate and the
  // entity gate. Only the store is in memory -- Postgres is the one part not exercised here.
  // Built lazily: `buildApi` widens the cube groups in place and, like boot, runs once per
  // process -- the auth and permissions groups are module singletons, so only the one HTTP
  // test composes it.
  let webHandler: ReturnType<typeof HttpApiBuilder.toWebHandler> | undefined
  const web = () => {
    if (webHandler) return webHandler
    const cubes = [
      { manifest: authCube.manifest, name: "auth", parts: auth, plugin: null, commands: [] },
      { manifest: permissionsCube.manifest, name: "permissions", parts: permissionsParts, plugin: null, commands: [] },
      { ...mounted, parts: { group, handlers: entityGated }, plugin: null, commands: [] },
    ] as unknown as ReadonlyArray<MountedCube>
    const api = buildApi(cubes)
    const ApiLive = HttpApiBuilder.api(api).pipe(
      Layer.provide(buildHandlers(api, cubes).pipe(Layer.provide(registry))),
      Layer.provide(authLive),
    )
    webHandler = HttpApiBuilder.toWebHandler(Layer.mergeAll(ApiLive, HttpServer.layerContext))
    return webHandler
  }
  const http = async (method: string, path: string, token?: string, body?: unknown) => {
    const response = await web().handler(
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
  return { service, ran, call, failure, effective, http, token, dispose: () => web().dispose() }
}

const root = { userId: "root", roles: ["admin"] }
const listRequest = { urlParams: { offset: 0, limit: 10 } }

describe("runtime cube capability grants -- route gate and entity gate stay two gates (QWB-63)", () => {
  it("ordinary reader is denied by the route gate before the handler runs", async () => {
    const w = world()
    const denied = await w.failure(w.call("mihai", ["reader"], "create", { payload: { id: "x", title: "x" } }))
    assert.equal(denied?.needed, "fixture:write")
    assert.deepEqual(w.ran, [])
  })

  it("a read grant gives exactly read, and the list still shows only visible entities", async () => {
    const w = world()
    await Effect.runPromise(w.service.grantCapability(root, { kind: "user", userId: "ana" }, "fixture:read"))
    assert.deepEqual(await Effect.runPromise(w.effective("ana", [])), ["fixture:read"])
    const empty = (await Effect.runPromise(w.call("ana", [], "list", listRequest))) as {
      rows: unknown[]
      total: number
    }
    assert.deepEqual([empty.rows.length, empty.total], [0, 0])
    await Effect.runPromise(
      w.service.claim({ userId: "ana", roles: [] }, { cube: "fixture", entityType: "Thing", entityId: "t2" }),
    )
    const page = (await Effect.runPromise(w.call("ana", [], "list", listRequest))) as {
      rows: Array<{ id: string }>
      total: number
    }
    assert.deepEqual([page.rows.map((r) => r.id), page.total], [["t2"], 1])
    assert.equal((await w.failure(w.call("ana", [], "get", { path: { id: "t1" } })))?.needed, "fixture:entity")
    assert.equal((await w.failure(w.call("ana", [], "create", { payload: {} })))?.needed, "fixture:write")
  })

  it("cube write plus entity edit permits update; cube write alone does not", async () => {
    const w = world()
    await Effect.runPromise(w.service.grantCapability(root, { kind: "user", userId: "ana" }, "fixture:write"))
    const ref = { cube: "fixture", entityType: "Thing", entityId: "t1" }
    await Effect.runPromise(w.service.claim(root, ref))
    assert.equal(
      (await w.failure(w.call("ana", [], "update", { path: { id: "t1" }, payload: {} })))?.needed,
      "fixture:entity",
    )
    assert.deepEqual(w.ran, [])
    await Effect.runPromise(w.service.grantUser(root, ref, "ana", ["edit"]))
    await Effect.runPromise(w.call("ana", [], "update", { path: { id: "t1" }, payload: {} }))
    assert.deepEqual(w.ran, ["update"])
  })

  it("an entity grant without the cube capability is stopped by the route gate", async () => {
    const w = world()
    const ref = { cube: "fixture", entityType: "Thing", entityId: "t1" }
    await Effect.runPromise(w.service.claim(root, ref))
    await Effect.runPromise(w.service.grantUser(root, ref, "ana"))
    assert.equal(
      (await w.failure(w.call("ana", [], "update", { path: { id: "t1" }, payload: {} })))?.needed,
      "fixture:write",
    )
    assert.deepEqual(w.ran, [])
  })

  it("group grant applies to members and stops on removal or revoke, on the next request", async () => {
    const w = world()
    const sales = await Effect.runPromise(w.service.createGroup(root, "fixture", "Sales"))
    await Effect.runPromise(w.service.addGroupMember(root, sales.id, "ioana"))
    const grant = await Effect.runPromise(
      w.service.grantCapability(root, { kind: "group", groupId: sales.id }, "fixture:read"),
    )
    assert.deepEqual(await Effect.runPromise(w.effective("ioana", [])), ["fixture:read"])
    await Effect.runPromise(w.service.removeGroupMember(root, sales.id, "ioana"))
    assert.deepEqual(await Effect.runPromise(w.effective("ioana", [])), [])
    await Effect.runPromise(w.service.addGroupMember(root, sales.id, "ioana"))
    await Effect.runPromise(w.service.revokeCapabilityGrant(root, grant.id))
    assert.deepEqual(await Effect.runPromise(w.effective("ioana", [])), [])
    assert.equal((await w.failure(w.call("ioana", [], "list", listRequest)))?.needed, "fixture:read")
    const audit = await Effect.runPromise(w.service.audit({ cube: "fixture", action: "capability.revoke" }))
    assert.equal(audit.length, 1)
  })

  it("only superadmin or the cube admin of THAT cube may grant; grantees cannot re-delegate", async () => {
    const w = world()
    const attempt = (actor: { userId: string; roles: ReadonlyArray<string> }, capability = "fixture:write") =>
      Effect.runPromise(Effect.flip(w.service.grantCapability(actor, { kind: "user", userId: "eve" }, capability)))
    assert.ok((await attempt({ userId: "mihai", roles: ["reader"] })) instanceof PermissionForbidden)
    await Effect.runPromise(w.service.grantCapability(root, { kind: "user", userId: "ana" }, "fixture:write"))
    assert.ok((await attempt({ userId: "ana", roles: [] })) instanceof PermissionForbidden)
    assert.ok(
      (await Effect.runPromise(
        Effect.flip(w.service.revokeCapabilityGrant({ userId: "ana", roles: [] }, "cap-1")),
      )) instanceof PermissionForbidden,
    )
    await Effect.runPromise(w.service.assignCubeAdmin(root, "other", "cuby"))
    assert.ok((await attempt({ userId: "cuby", roles: [] })) instanceof PermissionForbidden)
    await Effect.runPromise(w.service.assignCubeAdmin(root, "fixture", "cuby"))
    assert.equal(
      (
        await Effect.runPromise(
          w.service.grantCapability({ userId: "cuby", roles: [] }, { kind: "user", userId: "eve" }, "fixture:write"),
        )
      ).capability,
      "fixture:write",
    )
  })

  it("rejects undeclared capabilities and groups of another cube", async () => {
    const w = world()
    const undeclared = await Effect.runPromise(
      Effect.flip(w.service.grantCapability(root, { kind: "user", userId: "eve" }, "fixture:delete")),
    )
    assert.ok(undeclared instanceof PermissionInvalid)
    const foreign = await Effect.runPromise(w.service.createGroup(root, "other", "Ops"))
    const crossed = await Effect.runPromise(
      Effect.flip(w.service.grantCapability(root, { kind: "group", groupId: foreign.id }, "fixture:write")),
    )
    assert.ok(crossed instanceof PermissionInvalid)
    assert.deepEqual(await Effect.runPromise(w.service.listCapabilityGrants(root, "fixture")), [])
  })

  it("revoking an unknown grant id is not found; a repeated grant is idempotent and audited", async () => {
    const w = world()
    const missing = await Effect.runPromise(Effect.flip(w.service.revokeCapabilityGrant(root, "cap-404")))
    assert.ok(missing instanceof PermissionNotFound)
    const subject = { kind: "user", userId: "ana" } as const
    const first = await Effect.runPromise(w.service.grantCapability(root, subject, "fixture:read"))
    const again = await Effect.runPromise(w.service.grantCapability(root, subject, "fixture:read"))
    assert.equal(again.id, first.id)
    assert.equal((await Effect.runPromise(w.service.listCapabilityGrants(root, "fixture"))).length, 1)
    const audit = await Effect.runPromise(w.service.audit({ cube: "fixture", action: "capability.grant.user" }))
    assert.deepEqual(
      audit.map((event) => (event.before === null ? "new" : "repeat")),
      ["new", "repeat"],
    )
  })

  it("a grant of a cube that is no longer mounted names nothing", async () => {
    const mounted = new Map(declared)
    const w = world(mounted)
    await Effect.runPromise(w.service.grantCapability(root, { kind: "user", userId: "ana" }, "other:write"))
    assert.deepEqual(await Effect.runPromise(w.effective("ana", [])), ["other:write"])
    mounted.delete("other:write")
    assert.deepEqual(await Effect.runPromise(w.effective("ana", [])), [])
  })

  it("concurrent duplicate grants: one revoke, by either id, retires the capability", async () => {
    // A store whose reads take a tick, like Postgres: both fibers read "no grant" before either
    // inserts. No unique constraint in the store contract, so both land; access must still end
    // on revoke.
    const sync = memoryStore()
    const racy: CubeTools["store"] = {
      ...sync,
      page: (...args: Parameters<CubeTools["store"]["page"]>) => Effect.delay(sync.page(...args), 0),
    }
    const w = world(declared, racy)
    const grant = w.service.grantCapability(root, { kind: "user", userId: "ana" }, "fixture:read")
    const [left, right] = await Effect.runPromise(Effect.all([grant, grant], { concurrency: "unbounded" }))
    assert.notEqual(left.id, right.id, "the race must produce two rows, or this test proves nothing")
    assert.deepEqual(await Effect.runPromise(w.effective("ana", [])), ["fixture:read"])
    await Effect.runPromise(w.service.revokeCapabilityGrant(root, right.id))
    assert.deepEqual(await Effect.runPromise(w.effective("ana", [])), [])
    assert.deepEqual(await Effect.runPromise(w.service.listCapabilityGrants(root, "fixture")), [])
    const gone = await Effect.runPromise(Effect.flip(w.service.revokeCapabilityGrant(root, left.id)))
    assert.ok(gone instanceof PermissionNotFound)
  })

  it("roles stay as they were: revoking a grant leaves the role permission in place", async () => {
    const w = world()
    const grant = await Effect.runPromise(
      w.service.grantCapability(root, { kind: "user", userId: "mihai" }, "fixture:read"),
    )
    assert.deepEqual(await Effect.runPromise(w.effective("mihai", ["reader"])), ["fixture:read"])
    await Effect.runPromise(w.service.revokeCapabilityGrant(root, grant.id))
    assert.deepEqual(await Effect.runPromise(w.effective("mihai", ["reader"])), ["fixture:read"])
    assert.deepEqual(await Effect.runPromise(w.effective("root", ["admin"])), [
      "fixture:read",
      "fixture:write",
      "other:write",
    ])
  })
})

describe("the same matrix over HTTP: real router, real Authorization middleware, one token per user (QWB-63)", () => {
  it("grant and revoke change what the SAME token may do; the entity gate stays independent", async () => {
    const w = world()
    const root = await w.token("root", ["admin"])
    const ana = await w.token("ana", [])
    const needed = async (response: { status: number; body: Record<string, unknown> | null }) => {
      assert.equal(response.status, 403)
      return response.body?.needed
    }
    // Ordinary user: stopped by the route gate, handler never runs.
    assert.equal(await needed(await w.http("GET", "/fixture?offset=0&limit=10", ana)), "fixture:read")
    // Manager grants exactly read.
    const read = await w.http("POST", "/permissions/capabilities/user", root, {
      capability: "fixture:read",
      username: "ana",
    })
    assert.equal(read.status, 200)
    assert.equal(read.body?.capability, "fixture:read")
    const me = await w.http("GET", "/auth/me", ana)
    assert.deepEqual(me.body?.permissions, ["fixture:read"])
    const empty = await w.http("GET", "/fixture?offset=0&limit=10", ana)
    assert.deepEqual(
      [empty.status, (empty.body?.rows as unknown[] | undefined)?.length, empty.body?.total],
      [200, 0, 0],
    )
    assert.equal(await needed(await w.http("GET", "/fixture/t1", ana)), "fixture:entity")
    assert.equal(await needed(await w.http("POST", "/fixture", ana, { id: "x", title: "x" })), "fixture:write")
    // Cube write alone: route gate passes, entity gate refuses; entity edit grant then permits.
    const write = await w.http("POST", "/permissions/capabilities/user", root, {
      capability: "fixture:write",
      username: "ana",
    })
    assert.equal(write.status, 200)
    const ref = { cube: "fixture", entityType: "Thing", entityId: "t1" }
    await Effect.runPromise(w.service.claim({ userId: "root", roles: ["admin"] }, ref))
    assert.equal(await needed(await w.http("PATCH", "/fixture/t1", ana, { id: "t1", title: "y" })), "fixture:entity")
    assert.deepEqual(w.ran, [])
    await Effect.runPromise(w.service.grantUser({ userId: "root", roles: ["admin"] }, ref, "ana", ["edit"]))
    assert.equal((await w.http("PATCH", "/fixture/t1", ana, { id: "t1", title: "y" })).status, 200)
    assert.deepEqual(w.ran, ["update"])
    // Grantee is not a manager: cannot grant, revoke or list.
    const forbidden = await w.http("POST", "/permissions/capabilities/user", ana, {
      capability: "fixture:read",
      username: "eve",
    })
    assert.equal(forbidden.status, 403)
    assert.equal((await w.http("GET", "/permissions/capabilities?cube=fixture", ana)).status, 403)
    assert.equal((await w.http("DELETE", `/permissions/capabilities/${write.body?.id}`, ana)).status, 403)
    // Undeclared capability and a group of another cube are 400s; a manager sees both grants.
    const bad = await w.http("POST", "/permissions/capabilities/user", root, {
      capability: "fixture:delete",
      username: "ana",
    })
    assert.equal(bad.status, 400)
    const grants = await w.http("GET", "/permissions/capabilities?cube=fixture", root)
    assert.deepEqual((grants.body as unknown as Array<{ capability: string }>).map((g) => g.capability).sort(), [
      "fixture:read",
      "fixture:write",
    ])
    // Revoke write: the same token loses update on its next request, keeps read (additive).
    assert.equal((await w.http("DELETE", `/permissions/capabilities/${write.body?.id}`, root)).status, 200)
    assert.equal(await needed(await w.http("PATCH", "/fixture/t1", ana, { id: "t1", title: "z" })), "fixture:write")
    assert.equal((await w.http("GET", "/fixture?offset=0&limit=10", ana)).status, 200)
    assert.equal((await w.http("DELETE", `/permissions/capabilities/${read.body?.id}`, root)).status, 200)
    assert.equal(await needed(await w.http("GET", "/fixture?offset=0&limit=10", ana)), "fixture:read")
    assert.deepEqual((await w.http("GET", "/auth/me", ana)).body?.permissions, [])
    // Group member list over HTTP: offset/limit are honoured by the handler's slice, the
    // total is the whole active membership, and a user without authority over the cube is 403.
    const sales = await w.http("POST", "/permissions/groups", root, { cube: "fixture", name: "Sales" })
    assert.equal(sales.status, 200)
    for (const username of ["m1", "m2", "m3"]) {
      assert.equal(
        (await w.http("POST", `/permissions/groups/${sales.body?.id}/members`, root, { username })).status,
        200,
      )
    }
    const membersPath = `/permissions/groups/${sales.body?.id}/members`
    const secondPage = await w.http("GET", `${membersPath}?offset=2&limit=1`, root)
    assert.equal(secondPage.status, 200)
    assert.deepEqual(
      [
        (secondPage.body?.rows as Array<{ userId: string }> | undefined)?.map((row) => row.userId),
        secondPage.body?.total,
        secondPage.body?.offset,
        secondPage.body?.limit,
      ],
      [["m3"], 3, 2, 1],
    )
    assert.equal((await w.http("GET", membersPath, ana)).status, 403)
    assert.equal((await w.http("GET", membersPath)).status, 401)
    assert.equal((await w.http("GET", "/permissions/groups/grp-missing/members", root)).status, 404)
    await w.dispose()
  })
})
