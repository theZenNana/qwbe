// QWB-69: unit tests for the settings cube. The real handlers are driven with stubbed
// kernel capabilities (catalogue/switches/installer), never a built store: the manifest
// contract, the reader-permission refusal, the unknown-cube 404 and the required-cube
// protection are what this file pins down.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Effect } from "effect"
import type { CubeTools } from "qwbe-core/cube"
import { CurrentUser } from "../../kernel/auth-contract.ts"
import { BadRequest, Forbidden, NotFound } from "../../kernel/errors.ts"
import { baseTools } from "../../testing.ts"
import { cube } from "./index.ts"

const user = (permissions: ReadonlyArray<string>) => ({
  id: "acc-1",
  username: "ana",
  roles: permissions.includes("settings:write") ? ["admin"] : ["reader"],
  permissions,
  sessionId: "ses-1",
})

const settingsTools = (catalogueRows: ReadonlyArray<Record<string, unknown>> = []): CubeTools => {
  const installer = {
    cubeOnDisk: () => true,
    remove: (_name: string, _plugin: unknown) => Effect.succeed({ removed: true, requiresRestart: true }),
    restart: () => undefined,
    scanDirectory: () => [],
    forgetShelf: () => Effect.succeed({ removed: true, requiresRestart: false }),
  }
  const switches = {
    set: (_name: string, _enabled: boolean) => Effect.succeed(undefined),
  }
  return {
    store: baseTools().store,
    bus: { publish: () => Effect.void },
    catalogue: () => catalogueRows,
    switches,
    installer,
    entityPermissions: { capabilitiesFor: () => Effect.succeed([]) },
  } as unknown as CubeTools
}

const catalogueEntry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "notes",
  parent: null,
  enabled: true,
  required: false,
  system: true,
  plugin: null,
  prefix: null,
  entity: "Note",
  screen: true,
  agent: false,
  entityPermissions: false,
  publishes: [],
  links: [],
  ...over,
})

const run = (effect: Effect.Effect<unknown, unknown, never>) => Effect.runPromise(effect)

describe("settings cube contract (QWB-69)", () => {
  it("is required, holds the managesCubes privilege, and gates writes to admins", () => {
    assert.equal(cube.manifest.name, "settings")
    assert.equal(cube.manifest.required, true)
    assert.equal(cube.manifest.managesCubes, true)
    assert.equal(cube.manifest.requiresAuth, true)
    assert.deepEqual(cube.manifest.permissions, [
      { name: "settings:read", roles: ["admin", "reader"] },
      { name: "settings:write", roles: ["admin"] },
    ])
    const routes = cube.manifest.routes as Record<string, string>
    assert.equal(routes.toggle, "settings:write")
    assert.equal(routes.restart, "settings:write")
  })
})

describe("settings handlers over stubbed capabilities (QWB-69)", () => {
  it("lists cubes from the catalogue", async () => {
    const p = cube.create(settingsTools([catalogueEntry()]))
    const eff = Effect.provideService(
      (p.handlers.cubes as () => Effect.Effect<unknown, Forbidden, CurrentUser>)(),
      CurrentUser,
      user(["settings:read"]),
    )
    const out = (await run(eff)) as Array<Record<string, unknown>>
    assert.equal(out.length, 1)
    assert.equal(out[0]!.name, "notes")
    assert.equal(out[0]!.enabled, true)
  })

  it("refuses a reader on a write route (settings:write is admin-only)", async () => {
    const p = cube.create(settingsTools([catalogueEntry()]))
    const eff = Effect.provideService(
      (
        p.handlers.toggle as (a: {
          path: { name: string }
          payload: { enabled: boolean }
        }) => Effect.Effect<unknown, Forbidden, CurrentUser>
      )({
        path: { name: "notes" },
        payload: { enabled: false },
      }),
      CurrentUser,
      user(["settings:read"]),
    )
    const err = (await run(Effect.flip(eff))) as Forbidden
    assert.ok(err instanceof Forbidden)
    assert.equal(err.needed, "settings:write")
  })

  it("returns a typed NotFound when toggling a cube that is not mounted", async () => {
    const p = cube.create(settingsTools([catalogueEntry()]))
    const eff = Effect.provideService(
      (
        p.handlers.toggle as (a: {
          path: { name: string }
          payload: { enabled: boolean }
        }) => Effect.Effect<unknown, NotFound | Forbidden, CurrentUser>
      )({
        path: { name: "ghost-cube" },
        payload: { enabled: true },
      }),
      CurrentUser,
      user(["settings:write"]),
    )
    const err = (await run(Effect.flip(eff))) as NotFound
    assert.ok(err instanceof NotFound)
    assert.match(err.message, /not mounted/)
  })

  it("protects a required cube from uninstall with BadRequest", async () => {
    const p = cube.create(settingsTools([catalogueEntry({ name: "auth", required: true })]))
    const eff = Effect.provideService(
      (
        p.handlers.uninstall as (a: {
          path: { name: string }
        }) => Effect.Effect<unknown, NotFound | BadRequest | Forbidden, CurrentUser>
      )({
        path: { name: "auth" },
      }),
      CurrentUser,
      user(["settings:write"]),
    )
    const err = (await run(Effect.flip(eff))) as BadRequest
    assert.ok(err instanceof BadRequest)
    assert.match(err.message, /required and cannot be removed/)
  })
})
