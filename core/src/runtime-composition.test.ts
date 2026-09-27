// The mount wrapper is the one place every handler crosses (QWB-54, 14c): whatever `routes`
// declares must be required BEFORE the handler runs, so a handler that forgets
// `requirePermission` is still a 403. The wrapper is exercised directly -- building a served
// HttpApi in a unit test would buy nothing this does not already pin down -- but the
// permission always comes through `declaredPermission`, never a literal next to the call.

import assert from "node:assert/strict"
import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { CurrentUser, declaredPermission } from "./kernel/auth-contract.ts"
import type { MountedCube } from "./kernel/discovery.ts"
import { Forbidden } from "./kernel/errors.ts"
import { withDeclaredPermission } from "./runtime-composition.ts"

const actor = (permissions: ReadonlyArray<string>) => ({
  id: "u1",
  username: "u1",
  roles: ["reader"],
  permissions,
  sessionId: "ses-test",
})

// The declaration lives in the manifest, exactly as in production. The create handler
// deliberately NEVER calls requirePermission: the wrapper must supply the gate.
const manifest = { name: "fixture", routes: { create: "fixture:write" } }
const handlers = {
  create: () => Effect.succeed("ran"),
  // An endpoint with no declaration is left alone: per-request decisions stay possible.
  me: () => Effect.succeed("ran"),
}
const cube = {
  manifest,
  name: manifest.name,
  parts: { group: {}, handlers },
  plugin: null,
  commands: [],
} as unknown as MountedCube

const run = (handler: unknown, permissions: ReadonlyArray<string>): Effect.Effect<unknown, unknown, never> =>
  (handler as (request: unknown) => Effect.Effect<unknown, unknown, CurrentUser>)(undefined).pipe(
    Effect.provideService(CurrentUser, actor(permissions)),
  )

describe("withDeclaredPermission -- the declaration IS the enforcement (QWB-54, 14c)", () => {
  it.effect("refuses a handler that never checks its own permission, with the DECLARED name", () =>
    Effect.gen(function* () {
      const wrapped = withDeclaredPermission(cube, "create", handlers.create)
      const error = yield* Effect.flip(run(wrapped, []))
      assert.ok(error instanceof Forbidden)
      assert.equal(error.needed, manifest.routes.create)
      assert.equal(error.needed, declaredPermission(manifest.routes, manifest.name, "create"))
    }),
  )

  it.effect("runs the handler when the caller holds the declared permission", () =>
    Effect.gen(function* () {
      const wrapped = withDeclaredPermission(cube, "create", handlers.create)
      assert.equal(yield* run(wrapped, [manifest.routes.create]), "ran")
    }),
  )

  it.effect("leaves an endpoint with no declaration to decide per request", () =>
    Effect.gen(function* () {
      const wrapped = withDeclaredPermission(cube, "me", handlers.me)
      assert.equal(yield* run(wrapped, []), "ran")
    }),
  )
})
