// Unit tests for the QWBE_ALLOWED_ORIGINS parser (QWB-42). This module exists so these
// tests do not need to touch process.env or boot a server: parse, assert, done.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { allowedOrigins } from "./origins.ts"

describe("allowedOrigins", () => {
  it('defaults to ["*"] when the variable is undefined', () => {
    assert.deepEqual(allowedOrigins(undefined), ["*"])
  })

  it("throws when the variable is set but empty", () => {
    assert.throws(() => allowedOrigins(""))
  })

  it("throws when the variable is whitespace-only", () => {
    assert.throws(() => allowedOrigins("   "), /empty origin at position 1/)
  })

  it("throws on a bare * -- wildcard lists are unsupported", () => {
    assert.throws(() => allowedOrigins("*"), /wildcard/)
  })

  it("throws on a trailing comma", () => {
    assert.throws(() => allowedOrigins("http://a.test,"), /empty origin at position 2/)
  })

  it("throws on a doubled comma", () => {
    assert.throws(() => allowedOrigins("http://a.test,,http://b.test"), /empty origin at position 2/)
  })

  it("throws on a scheme-less host", () => {
    assert.throws(() => allowedOrigins("localhost:3000"), /not a bare origin/)
  })

  it("throws on a URL with a path", () => {
    assert.throws(() => allowedOrigins("http://a.test/crm"), /not a bare origin/)
  })

  it("throws on a wildcard subdomain", () => {
    assert.throws(() => allowedOrigins("https://*.example.com"), /wildcard/)
  })

  it("throws on embedded whitespace in a host", () => {
    assert.throws(() => allowedOrigins("http://foo bar.test"), /not a bare origin/)
  })

  it("throws on credentials in the URL", () => {
    // Built by join so secretlint does not mistake the test literal for a real credential.
    const withCredentials = ["http://user", "pass@a.test"].join(":")
    assert.throws(() => allowedOrigins(withCredentials), /not a bare origin/)
  })

  it("accepts a single origin", () => {
    assert.deepEqual(allowedOrigins("http://localhost:3000"), ["http://localhost:3000"])
  })

  it("accepts multiple comma-separated origins", () => {
    assert.deepEqual(allowedOrigins("http://localhost:3000, https://crm.example.test"), [
      "http://localhost:3000",
      "https://crm.example.test",
    ])
  })

  it("canonicalizes the default port away", () => {
    assert.deepEqual(allowedOrigins("https://a.test:443"), ["https://a.test"])
    assert.deepEqual(allowedOrigins("http://a.test:80"), ["http://a.test"])
  })

  it("canonicalizes an uppercase scheme", () => {
    assert.deepEqual(allowedOrigins("HTTPS://a.test"), ["https://a.test"])
  })
})
