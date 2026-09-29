// B1: a batch that dies must flip the set to `failed`. The store's error channel is `never`, so
// the failure arrives as a defect; only a cause-level tap sees it.

import assert from "node:assert/strict"
import { describe, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import type { CubeTools } from "qwbe-core/cube"
import { CurrentUser } from "../../kernel/auth-contract.ts"
import { baseTools, currentUser } from "../../test-cube-tools.ts"
import { TABLES } from "./contract.ts"
import { stagingHandlers } from "./handlers.ts"

describe("staging chunk", () => {
  it.effect("marks the set failed when the store batch rejects", () =>
    Effect.gen(function* () {
      const tools = baseTools()
      const set = (yield* tools.store.insert(TABLES.sets, "staging.set", "set", {
        name: "s",
        format: "jsonl",
        state: "importing",
      })) as { id: string }
      const { handlers } = stagingHandlers(tools, { batch: () => Effect.die(new Error("connection lost")) })

      const exit = yield* Effect.exit(
        handlers
          .chunk({ path: { id: set.id }, payload: { text: '{"a":1}\n', startLine: 1 } })
          .pipe(Effect.provideService(CurrentUser, currentUser({ permissions: ["staging:write"] }))),
      )

      assert.ok(Exit.isFailure(exit))
      const row = (yield* tools.store.byId(TABLES.sets, set.id)) as { state: string }
      assert.equal(row.state, "failed")
    }),
  )
})

describe("staging listSets", () => {
  const reader = Effect.provideService(CurrentUser, currentUser({ permissions: ["staging:read"] }))
  const seeded = (n: number) =>
    Effect.gen(function* () {
      const tools = baseTools()
      for (let i = 0; i < n; i++) {
        yield* tools.store.insert(TABLES.sets, "staging.set", "set", { name: `s${i}`, format: "jsonl", state: "done" })
      }
      return tools
    })

  it.effect("returns one page and the total, not every set", () =>
    Effect.gen(function* () {
      const tools = yield* seeded(5)
      const { handlers } = stagingHandlers(tools, { batch: () => Effect.succeed([]) })
      const page = yield* handlers.listSets({ urlParams: { page: 2, pageSize: 2 } }).pipe(reader)
      assert.equal(page.total, 5)
      assert.equal(page.offset, 2)
      assert.equal(page.limit, 2)
      assert.deepEqual(
        page.rows.map((r) => r.name),
        ["s2", "s3"],
      )
    }),
  )

  it.effect("answers an empty page for an offset past the end", () =>
    Effect.gen(function* () {
      const tools = yield* seeded(3)
      const { handlers } = stagingHandlers(tools, { batch: () => Effect.succeed([]) })
      const page = yield* handlers.listSets({ urlParams: { offset: 10, limit: 5 } }).pipe(reader)
      assert.equal(page.total, 3)
      assert.deepEqual(page.rows, [])
    }),
  )

  it.effect("hands the requested sort to the store", () =>
    Effect.gen(function* () {
      const tools = yield* seeded(1)
      let asked: Parameters<CubeTools["store"]["page"]>[1] | undefined
      const store: CubeTools["store"] = {
        ...tools.store,
        page: (table, page, where) => {
          asked = page
          return tools.store.page(table, page, where)
        },
      }
      const { handlers } = stagingHandlers({ ...tools, store }, { batch: () => Effect.succeed([]) })
      yield* handlers.listSets({ urlParams: { sort: "name:desc" } }).pipe(reader)
      assert.equal(asked?.sortBy, "name")
      assert.equal(asked?.descending, true)
    }),
  )

  it.effect("refuses a caller without staging:read", () =>
    Effect.gen(function* () {
      const { handlers } = stagingHandlers(baseTools(), { batch: () => Effect.succeed([]) })
      const exit = yield* Effect.exit(
        handlers.listSets({ urlParams: {} }).pipe(Effect.provideService(CurrentUser, currentUser({ permissions: [] }))),
      )
      assert.ok(Exit.isFailure(exit))
    }),
  )
})
