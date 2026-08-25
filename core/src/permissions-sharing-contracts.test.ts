import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Schema } from "effect"
import { GroupGrantCreate, TotalActions, UserGrantCreate } from "./permissions-contracts.ts"

describe("permissions sharing public contracts", () => {
  it("an @username grant defaults to TOTAL", () => {
    const decoded = Schema.decodeUnknownSync(UserGrantCreate)({ username: "mihai" })
    assert.deepEqual(decoded.actions, TotalActions)
  })

  it("a group grant requires explicit custom actions", () => {
    assert.throws(() => Schema.decodeUnknownSync(GroupGrantCreate)({ groupId: "sales" }))
    assert.deepEqual(Schema.decodeUnknownSync(GroupGrantCreate)({ groupId: "sales", actions: ["read"] }).actions, [
      "read",
    ])
  })

  it("refuses actions outside the public vocabulary", () => {
    assert.throws(() =>
      Schema.decodeUnknownSync(UserGrantCreate)({ username: "mihai", actions: ["read", "become-superadmin"] }),
    )
  })
})
