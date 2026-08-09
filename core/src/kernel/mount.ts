// Contract composition and the LIFE RULES.
//
// The central rule: a cube that is not wired into authentication is not "alive but returning
// 401" — it does not exist. Two layers, not one:
//
//   1. AT MOUNT (here): a cube with `requiresAuth: true` does not mount at all if the `auth`
//      cube is absent. The server refuses to start and says why.
//   2. AT REQUEST (in each cube): `.middleware(Authorization)` on the group, so 401 is declared
//      in the contract and visible in the emitted OpenAPI.
//
// The test that matters, and the standard for any rule added from here on: verification reads
// the REAL ARTEFACT (`group.endpoints[].middlewares`), never a flag the cube sets on itself. A
// flag is a promise; the middleware is what will run. A cube cannot lie.

import {
  HttpApi,
  HttpApiBuilder,
  HttpMiddleware,
  HttpServerRequest,
  HttpServerResponse,
  OpenApi,
} from "@effect/platform"
import { Effect, Layer } from "effect"
import type { MountedCube } from "./discovery.ts"
import { danglingLinks, type SpaceDefinition } from "./space.ts"

export class DeadCubeError extends Error {
  constructor(names: ReadonlyArray<string>) {
    super(
      `Dead cubes: ${names.join(", ")}. ` +
        `Each requires authentication, but the "auth" cube is not mounted. ` +
        `A cube without auth is not "alive and returning 401" — it does not exist at all. ` +
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
 * A dangling link is a WARNING, never fatal — and getting that wrong once is worth recording.
 *
 * The first version of this check threw. The invariant probe caught it immediately: deleting
 * the `notes` directory stopped the server, because the space still declared a link to it. That
 * would mean uninstalling a cube requires editing a file that is not yours — the exact thing
 * the whole design exists to prevent.
 *
 * And there is no way to tell a typo from a deliberate removal: both look like "the other end
 * is not here". So it cannot be fatal.
 *
 * What is done instead: the link is inactive (`activeLinks` already filters to mounted and
 * enabled), and the problem is printed loudly at startup and carried in the mounted system so
 * the UI can show it. Visible rather than fatal — because the failure mode being guarded
 * against is a silent empty list, and a warning fixes that just as well.
 */
export type DanglingLink = {
  readonly space: string
  readonly from: string
  readonly to: string
  readonly reason: string
}

export class RouteOwnershipError extends Error {
  constructor(problems: ReadonlyArray<{ cube: string; path: string; prefix: string }>) {
    super(
      `Cubes declaring routes outside their own prefix:\n` +
        problems.map((p) => `  - cube "${p.cube}" declares ${p.path} (prefix "${p.prefix}")`).join("\n") +
        `\nEvery route must start with the cube's own name. Without that rule, a cube can serve ` +
        `endpoints under another cube's prefix — and switching a cube off, which matches on the ` +
        `first path segment, then misses them entirely. Demonstrated by review: a hostile cube ` +
        `kept answering on /notes/backdoor after Settings reported it disabled.`,
    )
    this.name = "RouteOwnershipError"
  }
}

/**
 * Every endpoint of a cube must live under `/<cube-name>/…`.
 *
 * This is what makes prefix-based switching sound. `rejectDisabled` matches the first path
 * segment; if two cubes could share a segment, the first match wins and the other becomes
 * unreachable by the switch. Rather than make the matcher cleverer, the ambiguity is removed.
 */
export const checkRouteOwnership = (cubes: ReadonlyArray<MountedCube>): void => {
  const problems: Array<{ cube: string; path: string; prefix: string }> = []
  for (const c of cubes) {
    const group = c.parts.group as { endpoints?: Record<string, { path?: string }> }
    for (const e of Object.values(group.endpoints ?? {})) {
      const path = e.path ?? ""
      const prefix = path.split("/").filter(Boolean)[0] ?? ""
      if (prefix !== c.manifest.name) {
        problems.push({ cube: c.manifest.name, path, prefix })
      }
    }
  }
  if (problems.length > 0) throw new RouteOwnershipError(problems)
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

  // Fatal: a cube serving routes under someone else's prefix — see `checkRouteOwnership`.
  checkRouteOwnership(cubes)

  // Not fatal: links whose other end is not mounted. Reported, not thrown — see `DanglingLink`.
  return danglingLinks(
    spaces,
    cubes.map((c) => ({ name: c.manifest.name, entity: c.manifest.entity })),
  ).map((d) => ({ space: d.space, from: d.link.from, to: d.link.to, reason: d.reason }))
}

/**
 * Compose one contract from the mounted cubes.
 *
 * WHY the `any`, not merely that it is there:
 *
 * The type of a composed `HttpApi` IS its list of groups — `.add(g1).add(g2)` has a different
 * type from `.add(g1)`. Keeping the static type means composing statically, i.e. writing the
 * list of cubes in code. But discovery at runtime is the entire point: a list in code is the
 * central registry we removed, wearing a different hat.
 *
 * Checked against the Effect docs: `add()` and `addHttpApi()` exist and the API is chainable
 * since 3.10, but no documented pattern exists for optionally-mounted groups with types
 * preserved, and there is no large open-source Effect application to copy a solution from. So
 * this is a price paid deliberately, confined to two functions — not a hole left open.
 *
 * What is recovered: the emitted OpenAPI is complete, and the frontend takes its shapes there.
 */
// Tipul de întoarcere e `HttpApi<"cubes", never, never, never>`, nu `unknown`, și diferența
// merită spusă pentru că e ușor de citit greșit ca pe o minciună mai mare.
//
// `unknown` nu spunea nimic, iar `main.ts` era obligat să-l treacă printr-un `as never` ca să-l
// poată da lui `HttpApiBuilder.api`. Din cast-ul ăla inferența ieșea cu `R = unknown`, care se
// propaga până la `NodeRuntime.runMain` și pica acolo — o eroare la 60 de rânduri distanță de
// cauză. Numele tipului de aici mută diagnosticul la sursă.
//
// Ce declară, exact: grupurile acestui `HttpApi` nu cer nimic din context. E aceeași afirmație
// pe care o face deja `buildHandlers`, întorcând `Layer<never, never, never>` — handlerele CHIAR
// furnizează serviciile grupurilor la rulare, doar că tipul lor nu le poate număra. Nu se adaugă
// un cast nou; cel existent e dus până la capătul lui, în loc să lase `unknown` să curgă.
//
// Ce NU se rezolvă: `any`-ul de mai jos. Vezi comentariul de deasupra.
export const buildApi = (cubes: ReadonlyArray<MountedCube>): HttpApi.HttpApi<"cubes", never, never, never> => {
  const empty = HttpApi.make("cubes")
    .annotate(OpenApi.Title, "Qwbe — kernel plus cubes discovered from disk")
    .annotate(
      OpenApi.Description,
      "One cube = one directory. Installing it touches no existing file. Plugins land in the same namespace.",
    )
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return cubes.reduce<any>((api, c) => api.add(c.parts.group), empty)
}

/**
 * One handler layer per cube, over the contract built above.
 *
 * `mergeAll` asks for a NON-EMPTY tuple, and a mount with no cubes is a real state — the switches
 * can turn every one of them off. Spreading a plain array at it type-checked as
 * "A spread argument must either have a tuple type", which is the compiler saying it cannot
 * promise there is a first element. So the first one is taken out by hand and the empty case
 * answers `Layer.empty`, which is what "no handlers" means.
 */
export const buildHandlers = (api: unknown, cubes: ReadonlyArray<MountedCube>): Layer.Layer<never, never, never> => {
  const layers = cubes.map((c) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    HttpApiBuilder.group(api as any, c.manifest.name as never, (h: any) =>
      Object.entries(c.parts.handlers).reduce((acc, [name, impl]) => acc.handle(name, impl), h),
    ),
  )
  const [first, ...rest] = layers
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (first === undefined ? Layer.empty : Layer.mergeAll(first, ...rest)) as any
}

/**
 * Reject requests to disabled cubes BEFORE dispatch.
 *
 * Sitting ahead of the API means a cube switched off in Settings returns 404 without touching
 * authentication or any handler. The second layer of switching off is in the registry, where a
 * disabled cube also vanishes from everyone else's related lists — so its tabs disappear from
 * the UI too, because the frontend takes tabs from the catalogue.
 *
 * Route prefixes are read from each cube's REAL contract, not a hand-written table: if a cube
 * changes its routes, switching off follows by itself.
 */
export const rejectDisabled = (cubes: ReadonlyArray<MountedCube>, isEnabled: (name: string) => boolean) => {
  // `checkRouteOwnership` has already guaranteed that a route's first segment IS the cube name,
  // so the mapping is exact and a lookup can never land on the wrong cube. The earlier version
  // scanned a list and took the first match, which is how a cube declaring `/notes/backdoor`
  // stayed reachable after `notes` was switched off.
  const owner = new Map(cubes.map((c) => [c.manifest.name, c.manifest.name]))

  return HttpMiddleware.make((app) =>
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest
      const first = (req.url.split("?")[0] ?? "").split("/").filter(Boolean)[0]
      const match = first && owner.has(first) ? { cube: first } : undefined
      if (match && !isEnabled(match.cube)) {
        // Byte-for-byte what an unmatched route returns: 404 with an empty body. Anything else
        // — even a generic JSON message — distinguishes "switched off" from "never existed",
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
