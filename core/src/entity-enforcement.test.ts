import assert from "node:assert/strict"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { describe, it } from "@effect/vitest"
import { Cause, Effect, Schema } from "effect"
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
            authorizeList: () => Effect.die("unused"),
            auditList: () => Effect.die("unused"),
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
        authorizeList: () => Effect.die("unused"),
        auditList: () => Effect.die("unused"),
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
        authorizeList: () => Effect.die("unused"),
        auditList: () => Effect.die("unused"),
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
          authorizeList: () => Effect.die("unused"),
          auditList: () => Effect.die("unused"),
          claim: () => Effect.die("unused"),
          ownership: () => Effect.succeed(undefined),
        },
      )
      assert.match(yield* refusal(handlers.get({ path: { secretId: "s1" } })), /not shared/)
      assert.equal(calls, 0)
    }),
  )
})

describe("kernel entity list mediation (Qwbe#73)", () => {
  // Five source rows. The fake handler honours `ids` and offset/limit, as genericList and
  // store.page do in SQL, and records what it was asked.
  const source = ["a", "b", "c", "d", "e"].map((id) => ({ id, secret: id }))
  const listing = (visible: "all" | ReadonlySet<string>, opts: { ignoreIds?: boolean } = {}) => {
    const calls: Array<Record<string, unknown>> = []
    const audits: Array<{ source: string; ids: ReadonlyArray<string> }> = []
    const handlers = enforceEntityHandlers(
      "hostile",
      "Secret",
      group,
      {
        list: (request: unknown) =>
          Effect.sync(() => {
            const params = (request as { urlParams: Record<string, unknown> }).urlParams
            calls.push(params)
            const ids = typeof params.ids === "string" && !opts.ignoreIds ? params.ids.split(",") : undefined
            const hit = ids ? source.filter((row) => ids.includes(row.id)) : source
            const offset = Number(params.offset ?? 0)
            const limit = Number(params.limit ?? 25)
            return { rows: hit.slice(offset, offset + limit), total: hit.length, offset, limit, sortedBy: "createdAt" }
          }),
        get: () => Effect.die("unused"),
        create: () => Effect.die("unused"),
        remove: () => Effect.die("unused"),
      },
      {
        authorize: () => Effect.die("a list must not authorize per row"),
        authorizeList: () => Effect.succeed(visible),
        auditList: (_actor, _scope, _action, source, ids) =>
          Effect.sync(() => {
            audits.push({ source, ids })
          }),
        claim: () => Effect.die("unused"),
        ownership: () => Effect.succeed(undefined),
      },
    )
    return { list: handlers.list, calls, audits }
  }

  it.effect("a stranger gets an empty page, the handler never runs, one audit row", () =>
    Effect.gen(function* () {
      const { list, calls, audits } = listing(new Set())
      assert.deepEqual(yield* run(list({ urlParams: { offset: 0, limit: 10 } })), {
        rows: [],
        total: 0,
        offset: 0,
        limit: 10,
        sortedBy: "createdAt",
      })
      assert.equal(calls.length, 0)
      assert.deepEqual(audits, [{ source: "scoped", ids: [] }])
    }),
  )

  it.effect("a scoped user gets only their rows, the right total and the asked page in one call", () =>
    Effect.gen(function* () {
      const { list, calls, audits } = listing(new Set(["b", "c", "e"]))
      assert.deepEqual(yield* run(list({ urlParams: { page: 2, pageSize: 2, kind: "x" } })), {
        rows: [{ id: "e", secret: "e" }],
        total: 3,
        offset: 2,
        limit: 2,
        sortedBy: "createdAt",
      })
      assert.equal(calls.length, 1)
      // Explicit paging, so the injected batch does not become the page size; other filters stay.
      assert.equal(calls[0]?.offset, 2)
      assert.equal(calls[0]?.limit, 2)
      assert.equal(calls[0]?.page, undefined)
      assert.equal(calls[0]?.kind, "x")
      assert.deepEqual(audits, [{ source: "scoped", ids: ["e"] }])
    }),
  )

  it.effect("a caller's own ids are narrowed to the visible set", () =>
    Effect.gen(function* () {
      const { list, calls } = listing(new Set(["b", "c"]))
      const page = yield* run(list({ urlParams: { ids: "a,c" } }))
      assert.deepEqual(calls[0]?.ids, "c")
      assert.deepEqual(page.rows, [{ id: "c", secret: "c" }])
    }),
  )

  it.effect("an admin's list runs the handler unchanged", () =>
    Effect.gen(function* () {
      const { list, calls, audits } = listing("all")
      const page = yield* list({ urlParams: { offset: 1, limit: 2 } }).pipe(
        Effect.provideService(CurrentUser, { ...actor, roles: ["admin"] }),
      )
      assert.deepEqual(
        page.rows.map((row) => row.id),
        ["b", "c"],
      )
      assert.equal(page.total, 5)
      assert.deepEqual(calls, [{ offset: 1, limit: 2 }])
      assert.deepEqual(audits, [{ source: "superadmin", ids: ["b", "c"] }])
    }),
  )

  it.effect("a handler that ignores ids makes the wrapper die instead of leaking rows", () =>
    Effect.gen(function* () {
      const { list, audits } = listing(new Set(["b"]), { ignoreIds: true })
      const exit = yield* Effect.exit(run(list({ urlParams: {} })))
      assert.ok(exit._tag === "Failure" && Cause.pretty(exit.cause).includes("outside the visible ids"))
      assert.equal(audits.length, 0)
    }),
  )
})
