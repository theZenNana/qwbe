// B4: hashing runs on the async scrypt, behind an Effect, with the encoded format unchanged.

import assert from "node:assert/strict"
import { Effect } from "effect"
import { describe, it } from "vitest"
import { hashPassword, verifyPassword } from "./password.ts"

// Produced by the scryptSync version: hashPassword("correct horse", Buffer.alloc(16, 7)).
const LEGACY = "scrypt$16384$8$1$BwcHBwcHBwcHBwcHBwcHBw$5TRHB2ApnfGdNDl3bNPaEguAozb-v0jyBBXcGVyselY"

describe("password", () => {
  it("verifies a hash made by the previous synchronous code", async () => {
    assert.equal(await Effect.runPromise(verifyPassword("correct horse", LEGACY)), true)
    assert.equal(await Effect.runPromise(verifyPassword("wrong horse", LEGACY)), false)
  })

  it("encodes the same string as before for the same salt", async () => {
    assert.equal(await Effect.runPromise(hashPassword("correct horse", Buffer.alloc(16, 7))), LEGACY)
  })
})
