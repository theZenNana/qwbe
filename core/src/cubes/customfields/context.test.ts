// B2: a failed reload keeps the previous snapshot. Store failures arrive as defects, so only a
// cause-level catch sees them.
// Qwbe#73: a write refreshes only its target cube's definitions, never the whole table, and a
// stale read that resolves late cannot overwrite a newer one.

import assert from "node:assert/strict"
import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { CurrentUser } from "../../kernel/auth-contract.ts"
import { baseTools, currentUser } from "../../test-cube-tools.ts"
import { emptySnapshot, type PackTools, refreshSnapshot, type Snapshot } from "./context.ts"
import { definitionHandlers } from "./handlers.ts"
import { DEFS, type DefRow } from "./schema.ts"

describe("refreshSnapshot", () => {
  it.effect("keeps the old snapshot and succeeds when the store read rejects", () =>
    Effect.gen(function* () {
      const store = { ...baseTools().store, all: () => Effect.die(new Error("connection lost")) }
      const old = [{ id: "def-1", deleted: false }] as unknown as ReadonlyArray<DefRow>
      const snapshot: Snapshot = { ...emptySnapshot(), current: old }

      yield* refreshSnapshot(store, snapshot)

      assert.equal(snapshot.current, old)
    }),
  )

  it.effect("a cube read that started earlier does not overwrite one that started later", () =>
    Effect.gen(function* () {
      const store = baseTools().store
      yield* store.insert(DEFS, "CustomField", "cf", { targetCube: "notes", name: "a", deleted: false })
      const snapshot = emptySnapshot()
      snapshot.reads = 5
      snapshot.applied.set("notes", 7)

      yield* refreshSnapshot(store, snapshot, "notes")

      assert.deepEqual(snapshot.current, [])
    }),
  )
})

describe("definition writes", () => {
  it.effect("create, update and delete refresh only the target cube, never read every definition", () =>
    Effect.gen(function* () {
      const base = baseTools()
      let allCalls = 0
      const store = {
        ...base.store,
        all: <A>(table: string) => {
          allCalls++
          return base.store.all<A>(table)
        },
      }
      yield* store.insert(DEFS, "CustomField", "cf", { targetCube: "other", name: "kept", position: 0 })
      const tools = {
        store,
        bus: base.bus,
        catalogue: () => [{ name: "notes" }],
        customFields: {},
      } as unknown as PackTools
      const snapshot = emptySnapshot()
      yield* refreshSnapshot(store, snapshot)
      allCalls = 0
      const handlers = definitionHandlers(tools, snapshot)
      const run = <A, E>(eff: Effect.Effect<A, E, CurrentUser>) =>
        Effect.provideService(eff, CurrentUser, currentUser({ permissions: ["customfields:write"] }))

      const d = yield* run(
        handlers.define({
          payload: {
            targetCube: "notes",
            name: "cnp",
            label: "CNP",
            fieldType: "text",
            options: [],
            required: false,
            position: 1,
          },
        }),
      )
      assert.deepEqual(
        snapshot.current.map((r) => r.name),
        ["kept", "cnp"],
      )

      yield* run(handlers.update({ path: { id: d.id }, payload: { label: "Personal code" } }))
      assert.equal(snapshot.current.find((r) => r.id === d.id)?.label, "Personal code")

      yield* run(handlers.remove({ path: { id: d.id } }))
      assert.deepEqual(
        snapshot.current.map((r) => r.name),
        ["kept"],
      )
      assert.equal(allCalls, 0)
    }),
  )
})
