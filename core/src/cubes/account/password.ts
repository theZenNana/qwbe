import { randomBytes, scrypt, timingSafeEqual } from "node:crypto"
import { Effect } from "effect"

const N = 16_384
const R = 8
const P = 1
const KEY_LENGTH = 32
const SEPARATOR = String.fromCharCode(36)

// The async scrypt runs on the libuv pool, so a login no longer blocks the event loop.
const derive = (password: string, salt: Buffer, length: number, n: number, r: number, p: number) =>
  Effect.async<Buffer>((resume) =>
    scrypt(password, salt, length, { N: n, r, p }, (error, key) =>
      resume(error ? Effect.die(error) : Effect.succeed(key)),
    ),
  )

export const hashPassword = (password: string, salt = randomBytes(16)) =>
  Effect.map(derive(password, salt, KEY_LENGTH, N, R, P), (derived) =>
    ["scrypt", N, R, P, salt.toString("base64url"), derived.toString("base64url")].join(SEPARATOR),
  )

export const verifyPassword = (password: string, encoded: string) => {
  const [algorithm, n, r, p, saltText, expectedText] = encoded.split(SEPARATOR)
  if (algorithm !== "scrypt" || !n || !r || !p || !saltText || !expectedText) return Effect.succeed(false)
  const salt = Buffer.from(saltText, "base64url")
  const expected = Buffer.from(expectedText, "base64url")
  return Effect.map(
    derive(password, salt, expected.length, Number(n), Number(r), Number(p)),
    (actual) => actual.length === expected.length && timingSafeEqual(actual, expected),
  )
}

export const constantTimeEquals = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}
