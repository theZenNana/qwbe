import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Effect } from "effect"
import { busFrom } from "./bus.ts"

describe("declared event boundary", () => {
  it("delivers a declared event and refuses a name absent from manifest.publishes", async () => {
    const delivered: Array<unknown> = []
    const bus = busFrom(
      [
        {
          cube: "listener",
          subscription: { event: "crm/contacts.created", handle: (value) => Effect.sync(() => delivered.push(value)) },
        },
      ],
      () => true,
    )
    const publisher = bus.for("crm/contacts", ["crm/contacts.created"])
    bus.seal()

    await Effect.runPromise(publisher.publish("crm/contacts.created", { id: "one" }))
    assert.deepEqual(delivered, [{ id: "one" }])
    await assert.rejects(Effect.runPromise(publisher.publish("contacts.created", { id: "two" })), /undeclared event/)
  })
})
