import assert from "node:assert/strict"
import { describe, it } from "@effect/vitest"
import { Cause, Effect } from "effect"
import { busFrom } from "./bus.ts"

describe("declared event boundary", () => {
  it.effect("delivers a declared event and refuses a name absent from manifest.publishes", () =>
    Effect.gen(function* () {
      const delivered: Array<unknown> = []
      const bus = busFrom(
        [
          {
            cube: "listener",
            subscription: {
              event: "crm/contacts.created",
              handle: (value) => Effect.sync(() => delivered.push(value)),
            },
          },
        ],
        () => true,
      )
      const publisher = bus.for("crm/contacts", ["crm/contacts.created"])
      bus.seal()

      yield* publisher.publish("crm/contacts.created", { id: "one" })
      assert.deepEqual(delivered, [{ id: "one" }])
      const refused = yield* Effect.flip(Effect.sandbox(publisher.publish("contacts.created", { id: "two" })))
      assert.match(Cause.pretty(refused), /undeclared event/)
    }),
  )
})
