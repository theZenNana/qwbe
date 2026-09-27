import assert from "node:assert/strict"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { EntityPermissionContractError, enforceEntityHandlers } from "./entity-enforcement.ts"
import { CurrentUser } from "./kernel/auth-contract.ts"
import { Forbidden } from "./kernel/errors.ts"

const Row = Schema.Struct({ id: Schema.String, secret: Schema.String })
const Page = Schema.Struct({
  rows: Schema.Array(Row),
  total: Schema.Number,
  offset: Schema.Number,
  limit: Schema.Number,
  sortedBy: Schema.String,
})
const group = HttpApiGroup.make("hostile")
  .add(HttpApiEndpoint.get("list")`/hostile`.addSuccess(Page).addError(Forbidden))
  .add(
    HttpApiEndpoint.get("get")`/hostile/${HttpApiSchema.param("id", Schema.String)}`
      .addSuccess(Row)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.post("create")`/hostile`
      .setPayload(Schema.Struct({ secret: Schema.String }))
      .addSuccess(Row)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.del("remove")`/hostile/${HttpApiSchema.param("id", Schema.String)}`
      .addSuccess(Row)
      .addError(Forbidden),
  )

const actor = { id: "bob", username: "bob", roles: ["reader"], permissions: [], sessionId: "ses-test" }
const run = <A, E>(effect: Effect.Effect<A, E, CurrentUser>) => effect.pipe(Effect.provideService(CurrentUser, actor))
// The wrapped handlers keep the plugin's declared error type (often never); the gate's refusal is
// widened to unknown and read by instance.
const refusal = <A, E>(effect: Effect.Effect<A, E, CurrentUser>) =>
  Effect.map(Effect.flip(Effect.mapError(run(effect), (error): unknown => error)), (error) =>
    error instanceof Forbidden ? error.message : String(error),
  )

describe("kernel entity permission mediation", () => {
  it("refuses an installable entity contract that cannot encode the kernel's 403", () => {
    const unsafe = HttpApiGroup.make("hostile").add(
      HttpApiEndpoint.get("get")`/hostile/${HttpApiSchema.param("id", Schema.String)}`.addSuccess(Row),
    )
    assert.throws(
      () =>
        enforceEntityHandlers(
          "hostile",
          "Secret",
          unsafe,
          { get: () => Effect.succeed({ id: "s1", secret: "leak" }) },
          {
            authorize: () => Effect.succeed({ allowed: true, source: "owner" }),
            claim: () => Effect.die("unused"),
            ownership: () => Effect.succeed(undefined),
          },
        ),
      EntityPermissionContractError,
    )
  })

  it.effect("denies item reads and mutations before an adversarial plugin handler runs", () =>
    Effect.gen(function* () {
      let calls = 0
      const service = {
        authorize: () => Effect.succeed({ allowed: false, source: "none" as const }),
        claim: () => Effect.die("claim must not run"),
        ownership: () => Effect.succeed(undefined),
      }
      const handlers = enforceEntityHandlers(
        "hostile",
        "Secret",
        group,
        {
          list: () => Effect.die("unused"),
          get: (_request: unknown) =>
            Effect.sync(() => {
              calls += 1
              return { id: "s1", secret: "leaked" }
            }),
          create: () => Effect.die("unused"),
          remove: (_request: unknown) =>
            Effect.sync(() => {
              calls += 1
              return { id: "s1", secret: "deleted" }
            }),
        },
        service,
      )

      assert.match(yield* refusal(handlers.get({ path: { id: "s1" } })), /not shared/)
      assert.match(yield* refusal(handlers.remove({ path: { id: "s1" } })), /not shared/)
      assert.equal(calls, 0)
    }),
  )

  it.effect("claims a newly created row after the plugin handler returns its id", () =>
    Effect.gen(function* () {
      const claimed: Array<string> = []
      const service = {
        authorize: () => Effect.die("authorize must not run"),
        claim: (_actor: unknown, ref: { entityId: string }) =>
          Effect.sync(() => {
            claimed.push(ref.entityId)
          }),
        ownership: () => Effect.succeed(undefined),
      }
      const handlers = enforceEntityHandlers(
        "hostile",
        "Secret",
        group,
        {
          list: () => Effect.die("unused"),
          get: () => Effect.die("unused"),
          create: (_request: unknown) => Effect.succeed({ id: "s2", secret: "new" }),
          remove: () => Effect.die("unused"),
        },
        service,
      )

      assert.deepEqual(yield* run(handlers.create({ payload: { secret: "new" } })), { id: "s2", secret: "new" })
      assert.deepEqual(claimed, ["s2"])
    }),
  )

  it.effect("filters a PageOf collection through Permissions and repairs totals", () =>
    Effect.gen(function* () {
      const service = {
        authorize: (_actor: unknown, ref: { entityId: string }) =>
          Effect.succeed({
            allowed: ref.entityId === "mine",
            source: ref.entityId === "mine" ? ("owner" as const) : ("none" as const),
          }),
        claim: () => Effect.die("unused"),
        ownership: () => Effect.succeed(undefined),
      }
      const handlers = enforceEntityHandlers(
        "hostile",
        "Secret",
        group,
        {
          list: (_request: unknown) =>
            Effect.succeed({
              rows: [
                { id: "mine", secret: "yes" },
                { id: "other", secret: "no" },
              ],
              total: 2,
              offset: 0,
              limit: 10,
              sortedBy: "createdAt",
            }),
          get: () => Effect.die("unused"),
          create: () => Effect.die("unused"),
          remove: () => Effect.die("unused"),
        },
        service,
      )

      assert.deepEqual(yield* run(handlers.list({ urlParams: { offset: 0, limit: 10 } })), {
        rows: [{ id: "mine", secret: "yes" }],
        total: 1,
        offset: 0,
        limit: 10,
        sortedBy: "createdAt",
      })
    }),
  )

  it.effect("uses the contract's only path parameter instead of trusting the name id", () =>
    Effect.gen(function* () {
      let calls = 0
      const custom = HttpApiGroup.make("hostile").add(
        HttpApiEndpoint.get("get")`/hostile/${HttpApiSchema.param("secretId", Schema.String)}`
          .addSuccess(Row)
          .addError(Forbidden),
      )
      const handlers = enforceEntityHandlers(
        "hostile",
        "Secret",
        custom,
        {
          get: (_request: unknown) =>
            Effect.sync(() => {
              calls += 1
              return { id: "s1", secret: "leak" }
            }),
        },
        {
          authorize: () => Effect.succeed({ allowed: false, source: "none" }),
          claim: () => Effect.die("unused"),
          ownership: () => Effect.succeed(undefined),
        },
      )
      assert.match(yield* refusal(handlers.get({ path: { secretId: "s1" } })), /not shared/)
      assert.equal(calls, 0)
    }),
  )

  it.effect("scans source pages before applying caller paging", () =>
    Effect.gen(function* () {
      const paged = enforceEntityHandlers(
        "hostile",
        "Secret",
        group,
        {
          list: (request: unknown) => {
            const input = request as { urlParams: { offset: number; limit: number } }
            const all = [
              { id: "other", secret: "no" },
              { id: "mine", secret: "yes" },
            ]
            return Effect.succeed({
              rows: all.slice(input.urlParams.offset, input.urlParams.offset + input.urlParams.limit),
              total: 2,
              offset: input.urlParams.offset,
              limit: input.urlParams.limit,
              sortedBy: "createdAt",
            })
          },
          get: () => Effect.die("unused"),
          create: () => Effect.die("unused"),
          remove: () => Effect.die("unused"),
        },
        {
          authorize: (_actor, ref) =>
            Effect.succeed({ allowed: ref.entityId === "mine", source: ref.entityId === "mine" ? "owner" : "none" }),
          claim: () => Effect.die("unused"),
          ownership: () => Effect.succeed(undefined),
        },
      )
      const result = yield* run(paged.list({ urlParams: { offset: 0, limit: 1 } }))
      assert.deepEqual(result, {
        rows: [{ id: "mine", secret: "yes" }],
        total: 1,
        offset: 0,
        limit: 1,
        sortedBy: "createdAt",
      })
    }),
  )
})
