// B2: a failed reload keeps the previous snapshot. Store failures arrive as defects, so only a
// cause-level catch sees them.

import assert from "node:assert/strict"
import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { baseTools } from "../../test-cube-tools.ts"
import { refreshSnapshot, type Snapshot } from "./context.ts"
import type { DefRow } from "./schema.ts"

describe("refreshSnapshot", () => {
  it.effect("keeps the old snapshot and succeeds when the store read rejects", () =>
    Effect.gen(function* () {
      const store = { ...baseTools().store, all: () => Effect.die(new Error("connection lost")) }
      const old = [{ id: "def-1", deleted: false }] as unknown as ReadonlyArray<DefRow>
      const snapshot: Snapshot = { current: old }

      yield* refreshSnapshot(store, snapshot)

      assert.equal(snapshot.current, old)
    }),
  )
})
