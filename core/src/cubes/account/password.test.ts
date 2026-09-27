// B4: hashing runs on the async scrypt, behind an Effect, with the encoded format unchanged.

import assert from "node:assert/strict"
import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { hashPassword, verifyPassword } from "./password.ts"

// Produced by the scryptSync version: hashPassword("correct horse", Buffer.alloc(16, 7)).
const LEGACY = "scrypt$16384$8$1$BwcHBwcHBwcHBwcHBwcHBw$5TRHB2ApnfGdNDl3bNPaEguAozb-v0jyBBXcGVyselY"

describe("password", () => {
  it.effect("verifies a hash made by the previous synchronous code", () =>
    Effect.gen(function* () {
      assert.equal(yield* verifyPassword("correct horse", LEGACY), true)
      assert.equal(yield* verifyPassword("wrong horse", LEGACY), false)
    }),
  )

  it.effect("encodes the same string as before for the same salt", () =>
    Effect.gen(function* () {
      assert.equal(yield* hashPassword("correct horse", Buffer.alloc(16, 7)), LEGACY)
    }),
  )
})
