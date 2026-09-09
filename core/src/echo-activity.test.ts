// Echo A1 focused unit tests -- no database. Three contracts that must hold before any
// live-DB store test can be trusted:
//
//   1. `diffBody` (pg/rows.ts): the changes payload is a pure function of before/after;
//   2. `withActor` (runtime-composition.ts): the actor FiberRef is written ONLY from the
//      authenticated `CurrentUser` -- never from a caller-supplied request -- and stays
//      unset when there is no authenticated user;
//   3. `singleHolderOf` (kernel/discovery.ts): at most one holder per single-holder flag,
//      including `readsActivity`;
//   4. capture scope (entity-enforcement.ts + pg/store.ts): only the DECLARED entity type is
//      captured -- identity directory never, auxiliary types never.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Effect, Exit, FiberRef } from "effect"
import { captureEntity } from "./entity-enforcement.ts"
import { CurrentActor } from "./kernel/actor.ts"
import { CurrentUser } from "./kernel/auth-contract.ts"
import { singleHolderOf } from "./kernel/discovery.ts"
import type { Manifest } from "./kernel/manifest.ts"
import { InvalidManifestError, validateManifest } from "./kernel/manifest-validation.ts"
import { diffBody } from "./pg/rows.ts"
import { capturesType } from "./pg/store.ts"
import { withActor } from "./runtime-composition.ts"

// --- 1. diffBody ---

describe("diffBody", () => {
  it("an insert (before null) records every key as { to }", () => {
    assert.deepEqual(diffBody(null, { a: 1, b: "x" }), { a: { to: 1 }, b: { to: "x" } })
  })

  it("an update records only changed keys, with from and to", () => {
    assert.deepEqual(diffBody({ a: 1, b: "x" }, { a: 1, b: "y" }), { b: { from: "x", to: "y" } })
  })

  it("an update that removes a key records it as from -> undefined", () => {
    assert.deepEqual(diffBody({ a: 1 }, {}), { a: { from: 1 } })
  })

  it("keys absent from before count as inserted on update", () => {
    assert.deepEqual(diffBody({}, { a: 1 }), { a: { to: 1 } })
  })

  it("custom is diffed per sub-key, named custom.<name>", () => {
    assert.deepEqual(diffBody({ custom: { stage: "new", tag: "a" } }, { custom: { stage: "won", tag: "a" } }), {
      "custom.stage": { from: "new", to: "won" },
    })
  })

  it("a custom sub-key added or removed on update carries no explicit undefined", () => {
    assert.deepEqual(diffBody({ custom: {} }, { custom: { a: 1 } }), { "custom.a": { to: 1 } })
    assert.deepEqual(diffBody({ custom: { a: 1 } }, { custom: {} }), { "custom.a": { from: 1 } })
  })

  it("a non-object custom on either side is not republished", () => {
    assert.deepEqual(diffBody({ custom: { a: 1 } }, { custom: null }), {})
    assert.deepEqual(diffBody({ custom: null }, { custom: { a: 1 } }), {})
  })

  it("undefined and missing are equivalent", () => {
    assert.deepEqual(diffBody({ a: undefined }, {}), {})
  })
})

// --- 2. withActor -- the only writer of CurrentActor ---

const user = { id: "u1", username: "lucian", roles: [], permissions: [], sessionId: "s1" }

const actorSeenBy = (handler: (request: unknown) => Effect.Effect<unknown, unknown, CurrentUser>) =>
  Effect.runPromiseExit(
    handler({ maliciousActor: "spoof" }).pipe(
      Effect.locally(CurrentActor, { id: "spoof", username: "spoof" }),
      Effect.provideService(CurrentUser, user),
    ),
  )

// The `Effect.locally` above is the strongest spoof we can build in a unit test: a caller
// scoping the FiberRef around the call. The wrapper must overwrite it for the handler's
// duration from `CurrentUser`, so the spoof never reaches a store read.

describe("withActor", () => {
  it("copies the authenticated identity into CurrentActor", async () => {
    const wrapped = withActor(() =>
      Effect.gen(function* () {
        return yield* FiberRef.get(CurrentActor)
      }),
    )
    const exit = await Effect.runPromiseExit(
      (wrapped(undefined) as Effect.Effect<unknown, unknown, CurrentUser>).pipe(
        Effect.provideService(CurrentUser, user),
      ),
    )
    assert.ok(Exit.isSuccess(exit))
    assert.deepEqual(exit.value, { id: "u1", username: "lucian" })
  })

  it("ignores a caller-scoped CurrentActor (no spoof path)", async () => {
    let seen: unknown = "not-read"
    const wrapped = withActor(() =>
      Effect.gen(function* () {
        seen = yield* FiberRef.get(CurrentActor)
        return null
      }),
    )
    const result = await actorSeenBy(wrapped as (request: unknown) => Effect.Effect<unknown, unknown, CurrentUser>)
    assert.ok(Exit.isSuccess(result))
    // The spoof was overwritten: the handler saw the authenticated user, not the caller's.
    assert.deepEqual(seen, { id: "u1", username: "lucian" })
  })

  it("leaves the actor unset when there is no authenticated user (system write)", async () => {
    let seen: unknown = "not-read"
    const wrapped = withActor(() =>
      Effect.gen(function* () {
        seen = yield* FiberRef.get(CurrentActor)
        return null
      }),
    )
    await Effect.runPromiseExit(wrapped(undefined) as Effect.Effect<unknown, unknown, never>)
    assert.equal(seen, undefined)
  })
})

// --- 3. single-holder privileges, incl. readsActivity ---

const manifest = (name: string, flags: Partial<Manifest>): Manifest =>
  ({ name, tables: ["t"], permissions: [{ name: `${name}:read` }], ...flags }) as Manifest

describe("singleHolderOf", () => {
  it("accepts zero and one holder, for every single-holder flag", () => {
    assert.doesNotThrow(() => singleHolderOf([], "readsActivity"))
    assert.doesNotThrow(() => singleHolderOf([manifest("echo", { readsActivity: true })], "readsActivity"))
    assert.doesNotThrow(() => singleHolderOf([manifest("a", { managesCubes: true })], "managesCubes"))
    assert.doesNotThrow(() => singleHolderOf([manifest("a", { providesCustomFields: true })], "providesCustomFields"))
  })

  it("refuses two holders of readsActivity and names both", () => {
    assert.throws(
      () =>
        singleHolderOf(
          [manifest("echo", { readsActivity: true }), manifest("snoop", { readsActivity: true })],
          "readsActivity",
        ),
      /echo.*snoop|snoop.*echo/,
    )
  })

  it("refuses two holders of the other single-holder flags", () => {
    assert.throws(() =>
      singleHolderOf([manifest("a", { managesCubes: true }), manifest("b", { managesCubes: true })], "managesCubes"),
    )
    assert.throws(() =>
      singleHolderOf(
        [manifest("a", { providesCustomFields: true }), manifest("b", { providesCustomFields: true })],
        "providesCustomFields",
      ),
    )
  })
})

// --- 4. readsActivity declaration shape ---

describe("validateManifest -- readsActivity", () => {
  it("accepts a boolean flag", () => {
    assert.doesNotThrow(() => validateManifest("echo", manifest("echo", { readsActivity: true })))
    assert.doesNotThrow(() => validateManifest("echo", manifest("echo", {})))
  })

  it("refuses a non-boolean flag", () => {
    assert.throws(
      () => validateManifest("echo", manifest("echo", { readsActivity: "yes" as unknown as boolean })),
      InvalidManifestError,
    )
  })
})

// --- 5. capture scope: declared entity type only, auxiliary types never ---

describe("captureEntity", () => {
  it("returns the declared entity for an entity cube", () => {
    assert.equal(captureEntity({ entity: "Contact" }), "Contact")
  })

  it("excludes the identity directory and non-entity cubes", () => {
    assert.equal(captureEntity({ entity: "Account", providesIdentityDirectory: true }), undefined)
    assert.equal(captureEntity({}), undefined)
  })
})

describe("capturesType", () => {
  it("captures the declared entity type exactly", () => {
    assert.equal(capturesType("Contact", "Contact"), true)
  })

  it("does NOT capture an auxiliary type of the same cube", () => {
    assert.equal(capturesType("Contact", "ContactNote"), false)
    assert.equal(capturesType("Contact", "contact"), false)
  })

  it("captures nothing when the cube has no declared entity", () => {
    assert.equal(capturesType(undefined, "Contact"), false)
  })
})
