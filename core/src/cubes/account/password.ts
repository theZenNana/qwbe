import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto"

const N = 16_384
const R = 8
const P = 1
const KEY_LENGTH = 32
const SEPARATOR = String.fromCharCode(36)

export const hashPassword = (password: string, salt = randomBytes(16)): string => {
  const derived = scryptSync(password, salt, KEY_LENGTH, { N, r: R, p: P })
  return ["scrypt", N, R, P, salt.toString("base64url"), derived.toString("base64url")].join(SEPARATOR)
}

export const verifyPassword = (password: string, encoded: string): boolean => {
  const [algorithm, n, r, p, saltText, expectedText] = encoded.split(SEPARATOR)
  if (algorithm !== "scrypt" || !n || !r || !p || !saltText || !expectedText) return false
  const salt = Buffer.from(saltText, "base64url")
  const expected = Buffer.from(expectedText, "base64url")
  const actual = scryptSync(password, salt, expected.length, { N: Number(n), r: Number(r), p: Number(p) })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
