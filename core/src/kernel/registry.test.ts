import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Effect } from "effect"
import { registryFrom } from "../registry-runtime.ts"
import { Registry } from "./registry.ts"

const permissions = {
  authorize: (_actor: unknown, ref: { entityId: string }) =>
    Effect.succeed({
      allowed: ref.entityId === "mine",
      source: ref.entityId === "mine" ? ("owner" as const) : ("none" as const),
    }),
}
const user = { id: "bob", username: "bob", roles: ["reader"], permissions: [] }

describe("permission-mediated relational registry", () => {
  it("denies summary and field access before protected cube callbacks run", async () => {
    let calls = 0
    const layer = registryFrom(
      [
        {
          name: "notes",
          entity: "Note",
          relational: {
            summaryById: () =>
              Effect.sync(() => {
                calls += 1
                return { id: "other", title: "leak", details: [] }
              }),
            fieldValue: () =>
              Effect.sync(() => {
                calls += 1
                return "leak"
              }),
          },
        },
      ],
      () => [],
      () => true,
      permissions,
    )
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* Registry
        return [
          yield* registry.summary("Note", "other", user),
          yield* registry.fieldValue("notes", "other", "body", user),
        ]
      }).pipe(Effect.provide(layer)),
    )
    assert.deepEqual(result, [undefined, null])
    assert.equal(calls, 0)
  })

  it("keeps identity bootstrap relational access independent from CurrentUser", async () => {
    const layer = registryFrom(
      [
        {
          name: "account",
          entity: "Account",
          permissionExempt: true,
          relational: {
            summaryById: (id) => Effect.succeed({ id, title: "admin", details: [] }),
          },
        },
      ],
      () => [],
      () => true,
      permissions,
    )
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* Registry
        return yield* registry.summary("Account", "a1")
      }).pipe(Effect.provide(layer)),
    )
    assert.equal(result?.title, "admin")
  })
})
