// QWB-69: unit tests for the links cube. This cube owns no tables and talks only to the
// registry, so the tests drive the real handlers with a stubbed registry and a provided
// CurrentUser: the entity list, a typed NotFound for an unknown entity, and a typed
// NotFound when no space declares the requested link.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Context } from "effect"
import { Effect } from "effect"
import { CurrentUser } from "../../kernel/auth-contract.ts"
import { NotFound } from "../../kernel/errors.ts"
import type { LinkGroup } from "../../kernel/registry.ts"
import { Registry } from "../../kernel/registry.ts"
import { routeContracts } from "../../metadata/metadata.ts"
import { baseTools, currentUser } from "../../test-cube-tools.ts"
import { cube } from "./index.ts"

// The routes the kernel actually publishes, derived the one way (entity-less cube: no field
// metadata, so deriveCubeMetadata never reaches the routes -- routeContracts is that derivation).
const md = routeContracts(
  cube.manifest.name,
  cube.create({ store: {}, bus: { publish: () => undefined as never } } as never).group,
  cube.manifest,
)

const user = currentUser({ permissions: ["links:read"] })

// A minimal registry stub: only `entities` and `linksTo` are exercised here.
const stubRegistry = {
  entities: () => [{ cube: "notes", entity: "Note" }],
  linksTo: (entity: string): ReadonlyArray<LinkGroup> =>
    entity === "Note" ? [{ cube: "notes", label: "notes", field: "authorId" }] : [],
  linksFrom: (_cube: string) => [] as ReadonlyArray<never>,
} as unknown as Context.Tag.Service<typeof Registry>

const run = <A, E>(eff: Effect.Effect<A, E, CurrentUser | Registry>) =>
  Effect.runPromise(Effect.provideService(Effect.provideService(eff, CurrentUser, user), Registry, stubRegistry))

describe("links cube contract (QWB-69)", () => {
  it("owns no tables and publishes every route behind links:read", () => {
    assert.equal(cube.manifest.name, "links")
    assert.deepEqual(cube.manifest.tables, [])
    assert.deepEqual(cube.manifest.permissions, [{ name: "links:read", roles: ["admin", "reader"] }])
    assert.deepEqual(md, {
      entities: { auth: true, permission: "links:read", method: "GET", path: "/links" },
      for: { auth: true, permission: "links:read", method: "GET", path: "/links/:entity/:id" },
      group: { auth: true, permission: "links:read", method: "GET", path: "/links/:entity/:id/:cube" },
    })
  })
})

describe("links cube handlers over a stubbed registry (QWB-69)", () => {
  it("lists the entities the registry exposes", async () => {
    const p = cube.create(baseTools())
    const handler = p.handlers.entities as unknown as () => Effect.Effect<
      ReadonlyArray<{ cube: string; entity: string }>,
      NotFound,
      CurrentUser | Registry
    >
    const out = await run(handler())
    assert.deepEqual(out, [{ cube: "notes", entity: "Note" }])
  })

  it("returns a typed NotFound for an entity no active cube holds", async () => {
    const p = cube.create(baseTools())
    const handler = p.handlers.for as unknown as (a: {
      path: { entity: string; id: string }
    }) => Effect.Effect<unknown, NotFound, CurrentUser | Registry>
    const err = await run(Effect.flip(handler({ path: { entity: "Vault", id: "v-1" } })))
    assert.ok(err instanceof NotFound)
    assert.match(err.message, /no active cube holds entity Vault/)
  })

  it("returns a typed NotFound when no space declares a link for the group", async () => {
    const p = cube.create(baseTools())
    const handler = p.handlers.group as unknown as (a: {
      path: { entity: string; id: string; cube: string }
      urlParams: { offset: number; limit: number }
    }) => Effect.Effect<unknown, NotFound, CurrentUser | Registry>
    const err = await run(
      Effect.flip(
        handler({ path: { entity: "Note", id: "note-1", cube: "nope" }, urlParams: { offset: 0, limit: 10 } }),
      ),
    )
    assert.ok(err instanceof NotFound)
    assert.match(err.message, /no space declares a link from nope to Note/)
  })
})
