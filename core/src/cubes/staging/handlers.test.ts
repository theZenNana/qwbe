// B1: a batch that dies must flip the set to `failed`. The store's error channel is `never`, so
// the failure arrives as a defect; only a cause-level tap sees it.

import assert from "node:assert/strict"
import { Effect, Exit } from "effect"
import { describe, it } from "vitest"
import { CurrentUser } from "../../kernel/auth-contract.ts"
import { baseTools, currentUser } from "../../test-cube-tools.ts"
import { TABLES } from "./contract.ts"
import { stagingHandlers } from "./handlers.ts"

describe("staging chunk", () => {
  it("marks the set failed when the store batch rejects", async () => {
    const tools = baseTools()
    const set = (await Effect.runPromise(
      tools.store.insert(TABLES.sets, "staging.set", "set", { name: "s", format: "jsonl", state: "importing" }),
    )) as { id: string }
    const { handlers } = stagingHandlers(tools, { batch: () => Effect.die(new Error("connection lost")) })

    const exit = await Effect.runPromiseExit(
      handlers
        .chunk({ path: { id: set.id }, payload: { text: '{"a":1}\n', startLine: 1 } })
        .pipe(Effect.provideService(CurrentUser, currentUser({ permissions: ["staging:write"] }))),
    )

    assert.ok(Exit.isFailure(exit))
    const row = (await Effect.runPromise(tools.store.byId(TABLES.sets, set.id))) as { state: string }
    assert.equal(row.state, "failed")
  })
})
