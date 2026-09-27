// B1: a batch that dies must flip the set to `failed`. The store's error channel is `never`, so
// the failure arrives as a defect; only a cause-level tap sees it.

import assert from "node:assert/strict"
import { describe, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
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
