// The mount wrapper is the one place every handler crosses (QWB-54, 14c): whatever `routes`
// declares must be required BEFORE the handler runs, so a handler that forgets
// `requirePermission` is still a 403. The wrapper is exercised directly -- building a served
// HttpApi in a unit test would buy nothing this does not already pin down -- but the
// permission always comes through `declaredPermission`, never a literal next to the call.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Cause, Effect, Exit } from "effect"
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

/** The first typed failure, or null on success -- `runPromise` wraps errors, Exit does not. */
const failureOf = async (effect: Effect.Effect<unknown, unknown, never>) => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return null
  return (Array.from(Cause.failures(exit.cause))[0] as Forbidden | undefined) ?? null
}

describe("withDeclaredPermission -- the declaration IS the enforcement (QWB-54, 14c)", () => {
  it("refuses a handler that never checks its own permission, with the DECLARED name", async () => {
    const wrapped = withDeclaredPermission(cube, "create", handlers.create)
    const error = await failureOf(run(wrapped, []))
    assert.ok(error instanceof Forbidden)
    assert.equal(error.needed, manifest.routes.create)
    assert.equal(error.needed, declaredPermission(manifest.routes, manifest.name, "create"))
  })

  it("runs the handler when the caller holds the declared permission", async () => {
    const wrapped = withDeclaredPermission(cube, "create", handlers.create)
    assert.equal(await Effect.runPromise(run(wrapped, [manifest.routes.create])), "ran")
  })

  it("leaves an endpoint with no declaration to decide per request", async () => {
    const wrapped = withDeclaredPermission(cube, "me", handlers.me)
    assert.equal(await Effect.runPromise(run(wrapped, [])), "ran")
  })
})
