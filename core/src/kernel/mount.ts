// Contract composition and the LIFE RULES.
//
// The central rule: a cube that is not wired into authentication is not "alive but returning
// 401" -- it does not exist. Two layers, not one:
//
//   1. AT MOUNT (here): a cube with `requiresAuth: true` does not mount at all if the `auth`
//      cube is absent. The server refuses to start and says why.
//   2. AT REQUEST (in each cube): `.middleware(Authorization)` on the group, so 401 is declared
//      in the contract and visible in the emitted OpenAPI.
//
// The test that matters, and the standard for any rule added from here on: verification reads
// the REAL ARTEFACT (`group.endpoints[].middlewares`), never a flag the cube sets on itself. A
// flag is a promise; the middleware is what will run. A cube cannot lie.

import { HttpMiddleware, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect } from "effect"

export { buildApi, buildHandlers } from "../runtime-composition.ts"

import type { MountedCube } from "./discovery.ts"
import { checkRouteOwnership, routePrefixOf } from "./routes.ts"

export { checkRouteOwnership, DuplicateGroupError, PrefixCollisionError, RouteOwnershipError } from "./routes.ts"

import { danglingLinks, type SpaceDefinition } from "./space.ts"

export class DeadCubeError extends Error {
  constructor(names: ReadonlyArray<string>) {
    super(
      `Dead cubes: ${names.join(", ")}. ` +
        `Each requires authentication, but the "auth" cube is not mounted. ` +
        `A cube without auth is not "alive and returning 401" -- it does not exist at all. ` +
        `Mount "auth" or drop these from QWBE_MOUNTED.`,
    )
    this.name = "DeadCubeError"
  }
}

export class PublicEndpointError extends Error {
  constructor(cube: string, endpoints: ReadonlyArray<string>) {
    super(
      `Cube "${cube}" has endpoints without authentication: ${endpoints.join(", ")}. ` +
        `Only the "auth" cube may expose public endpoints (login). ` +
        `Put .middleware(Authorization) on the group or the endpoint.`,
    )
    this.name = "PublicEndpointError"
  }
}

/**
 * A dangling link is a WARNING, never fatal -- and getting that wrong once is worth recording.
 *
 * The first version of this check threw. The invariant probe caught it immediately: deleting
 * the `notes` directory stopped the server, because the space still declared a link to it. That
 * would mean uninstalling a cube requires editing a file that is not yours -- the exact thing
 * the whole design exists to prevent.
 *
 * And there is no way to tell a typo from a deliberate removal: both look like "the other end
 * is not here". So it cannot be fatal.
 *
 * What is done instead: the link is inactive (`activeLinks` already filters to mounted and
 * enabled), and the problem is printed loudly at startup and carried in the mounted system so
 * the UI can show it. Visible rather than fatal -- because the failure mode being guarded
 * against is a silent empty list, and a warning fixes that just as well.
 */
export type DanglingLink = {
  readonly space: string
  readonly from: string
  readonly to: string
  readonly reason: string
}

const AUTH_TAG = "cubes/Authorization"

const hasAuthorization = (group: unknown, endpoint: unknown): boolean => {
  const contains = (m: unknown) =>
    !!m && [...(m as Iterable<{ key?: string }>)].some((t) => (t?.key ?? String(t)) === AUTH_TAG)
  return (
    contains((group as { middlewares?: unknown }).middlewares) ||
    contains((endpoint as { middlewares?: unknown }).middlewares)
  )
}

/** Endpoints of a cube that answer WITHOUT a token. */
export const publicEndpoints = (c: MountedCube): ReadonlyArray<string> => {
  const group = c.parts.group as { endpoints?: Record<string, { name: string }> }
  return Object.values(group.endpoints ?? {})
    .filter((e) => !hasAuthorization(group, e))
    .map((e) => e.name)
}

/**
 * The three life checks. Any failure and the server does NOT start.
 *
 * Hard rather than warnings, for a measured reason: in the system this replaces, a migration
 * step was ticked off as done in the docs while `git log` showed the file untouched for three
 * weeks. A warning gets ignored exactly the same way. A gate you can walk through is not a gate.
 */
export const checkCubes = (
  cubes: ReadonlyArray<MountedCube>,
  spaces: ReadonlyArray<SpaceDefinition>,
): ReadonlyArray<DanglingLink> => {
  // Fatal: a cube that needs authentication with no auth cube present.
  if (!cubes.some((c) => c.manifest.name === "auth")) {
    const dead = cubes.filter((c) => c.manifest.requiresAuth).map((c) => c.manifest.name)
    if (dead.length > 0) throw new DeadCubeError(dead)
  }

  // Fatal: a data cube exposing an endpoint with no authorization on the REAL contract.
  for (const c of cubes) {
    if (c.manifest.name === "auth") continue
    const open = publicEndpoints(c)
    if (open.length > 0) throw new PublicEndpointError(c.manifest.name, open)
  }

  // Fatal: a cube serving routes under someone else's prefix -- see `checkRouteOwnership`.
  checkRouteOwnership(cubes)

  // Not fatal: links whose other end is not mounted. Reported, not thrown -- see `DanglingLink`.
  return danglingLinks(
    spaces,
    cubes.map((c) => ({ name: c.name, entity: c.manifest.entity })),
  ).map((d) => ({ space: d.space, from: d.link.from, to: d.link.to, reason: d.reason }))
}

/**
 * Reject requests to disabled cubes BEFORE dispatch.
 *
 * Sitting ahead of the API means a cube switched off in Settings returns 404 without touching
 * authentication or any handler. The second layer of switching off is in the registry, where a
 * disabled cube also vanishes from everyone else's related lists -- so its tabs disappear from
 * the UI too, because the frontend takes tabs from the catalogue.
 *
 * Route prefixes are read from each cube's REAL contract, not a hand-written table: if a cube
 * changes its routes, switching off follows by itself.
 */
export const rejectDisabled = (cubes: ReadonlyArray<MountedCube>, isEnabled: (name: string) => boolean) => {
  // `checkRouteOwnership` has already guaranteed that a route's first segment belongs to
  // exactly one cube, so the mapping is exact. The value is the cube's FULL name
  // (`booktags/bookmarks`), so the parent mask applies: a disabled parent hides every route
  // of every child. The key is the prefix the cube actually serves -- for a child whose leaf
  // name is taken by a standalone cube, that is `<parent>-<name>`.
  const owner = new Map(
    cubes.flatMap((c) => {
      const prefix = routePrefixOf(c)
      return prefix ? [[prefix, c.name] as const] : []
    }),
  )

  return HttpMiddleware.make((app) =>
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest
      const first = (req.url.split("?")[0] ?? "").split("/").filter(Boolean)[0]
      const cube = first ? owner.get(first) : undefined
      if (cube && !isEnabled(cube)) {
        // Byte-for-byte what an unmatched route returns: 404 with an empty body. Anything else
        // -- even a generic JSON message -- distinguishes "switched off" from "never existed",
        // and that difference answers "which cubes does this system have" to anyone, without a
        // token, in front of the authentication this check runs before.
        //
        // The first attempt at this fix named the cube and its state; the second returned a
        // tidy JSON 404, which the probe caught as still distinguishable. Matching exactly is
        // the only version that holds.
        return HttpServerResponse.empty({ status: 404 })
      }
      return yield* app
    }),
  )
}
