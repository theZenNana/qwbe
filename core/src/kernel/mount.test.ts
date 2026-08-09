// Unit tests for the mount-time gates on routes.
//
// Route ownership is what makes prefix-based switching sound. Review demonstrated the hole it
// closes: a cube declaring `/notes/backdoor` kept answering after `notes` was switched off,
// because the middleware matches on the first path segment and the segment was not its own.
// `publicEndpoints` is the other half — an endpoint with no Authorization middleware answers
// without a token, which is legitimate for `auth:login` and a hole anywhere else.

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { MountedCube } from "./discovery.ts"
import type { Manifest } from "./manifest.ts"
import { buildHandlers, checkRouteOwnership, publicEndpoints, RouteOwnershipError } from "./mount.ts"

const AUTH_TAG = "cubes/Authorization"

type FakeEndpoint = { name: string; path: string; middlewares?: Set<{ key: string }> }

/** Enough of a mounted cube for the two gates: a manifest name and a contract to read. */
const cube = (
  name: string,
  endpoints: ReadonlyArray<FakeEndpoint>,
  groupMiddlewares?: Set<{ key: string }>,
): MountedCube =>
  ({
    manifest: { name, tables: [], requiresAuth: true } as Manifest,
    parts: {
      group: {
        endpoints: Object.fromEntries(endpoints.map((e) => [e.name, e])),
        middlewares: groupMiddlewares,
      },
      handlers: {},
    },
    plugin: null,
    commands: [],
  }) as unknown as MountedCube

const authorized = new Set([{ key: AUTH_TAG }])

describe("checkRouteOwnership", () => {
  it("accepts a cube serving only under its own prefix", () => {
    assert.doesNotThrow(() =>
      checkRouteOwnership([
        cube("notes", [
          { name: "list", path: "/notes" },
          { name: "get", path: "/notes/:id" },
        ]),
      ]),
    )
  })

  it("accepts a system with no cubes at all", () => {
    assert.doesNotThrow(() => checkRouteOwnership([]))
  })

  // The demonstrated attack: `/notes/backdoor` declared by a cube that is not `notes`.
  it("refuses a cube declaring a route under another cube's prefix", () => {
    assert.throws(
      () => checkRouteOwnership([cube("evil", [{ name: "backdoor", path: "/notes/backdoor" }])]),
      RouteOwnershipError,
    )
  })

  it("names the cube, the path and the prefix it stole", () => {
    assert.throws(
      () => checkRouteOwnership([cube("evil", [{ name: "backdoor", path: "/notes/backdoor" }])]),
      /cube "evil" declares \/notes\/backdoor \(prefix "notes"\)/,
    )
  })

  it("refuses a root-level route, which belongs to no cube", () => {
    assert.throws(() => checkRouteOwnership([cube("notes", [{ name: "root", path: "/" }])]), RouteOwnershipError)
  })

  it("refuses a prefix that merely starts with the cube's name", () => {
    assert.throws(
      () => checkRouteOwnership([cube("notes", [{ name: "sneaky", path: "/notesx/all" }])]),
      RouteOwnershipError,
    )
  })

  it("reports every offending route, not just the first", () => {
    assert.throws(
      () =>
        checkRouteOwnership([
          cube("evil", [{ name: "a", path: "/notes/a" }]),
          cube("worse", [{ name: "b", path: "/account/b" }]),
        ]),
      (e: Error) => e.message.includes('cube "evil"') && e.message.includes('cube "worse"'),
    )
  })
})

describe("publicEndpoints", () => {
  it("lists an endpoint carrying no Authorization middleware", () => {
    assert.deepEqual(publicEndpoints(cube("auth", [{ name: "login", path: "/auth/login" }])), ["login"])
  })

  it("lists nothing when the whole group is behind Authorization", () => {
    assert.deepEqual(publicEndpoints(cube("notes", [{ name: "list", path: "/notes" }], authorized)), [])
  })

  it("lists nothing when the endpoint itself carries Authorization", () => {
    assert.deepEqual(publicEndpoints(cube("notes", [{ name: "list", path: "/notes", middlewares: authorized }])), [])
  })

  it("separates the public endpoints from the guarded ones in the same cube", () => {
    assert.deepEqual(
      publicEndpoints(
        cube("auth", [
          { name: "login", path: "/auth/login" },
          { name: "me", path: "/auth/me", middlewares: authorized },
        ]),
      ),
      ["login"],
    )
  })

  it("does not count an unrelated middleware as authorization", () => {
    assert.deepEqual(
      publicEndpoints(
        cube("notes", [{ name: "list", path: "/notes", middlewares: new Set([{ key: "cubes/Logging" }]) }]),
      ),
      ["list"],
    )
  })

  it("returns an empty list for a cube with no endpoints", () => {
    assert.deepEqual(publicEndpoints(cube("cli", [])), [])
  })
})

describe("buildHandlers", () => {
  // The branch that only a type error pointed at: `Layer.mergeAll` wants a non-empty tuple, and
  // a mount with zero cubes is a state the switches can produce. Nothing else exercises it —
  // every probe starts a server WITH cubes — so it is asserted here rather than left to a day
  // when someone turns the last one off and the server does not come up.
  it("answers with an empty layer when there is no cube to handle anything", () => {
    const layer = buildHandlers({}, [])
    assert.ok(layer !== undefined && typeof layer === "object")
  })
})
