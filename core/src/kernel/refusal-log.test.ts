// The refusal log (owner, 2026-08-31). These tests fail the day a 401 or a 403 goes back to
// being silent, or the day a token reaches the log.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect, Logger, Option } from "effect"

import { logRefusals, refusalLine, tokenHandle } from "./refusal-log.ts"

const request = (headers: Record<string, string> = {}, url = "/notes", method = "GET") =>
  ({
    method,
    url,
    headers,
    remoteAddress: Option.some("127.0.0.1"),
  }) as unknown as HttpServerRequest.HttpServerRequest

const jsonBody = (value: unknown, status: number) => ({
  status,
  body: { _tag: "Uint8Array" as const, body: new TextEncoder().encode(JSON.stringify(value)) },
})

describe("the refusal log", () => {
  it("names the reason the refusal stated", () => {
    const line = refusalLine(
      request({ authorization: "Bearer abc.def" }),
      jsonBody({ _tag: "Unauthorized", message: "unknown token" }, 401) as never,
    )
    assert.match(line, /status=401/)
    assert.match(line, /method=GET route=\/notes/)
    assert.match(line, /reason="unknown token"/)
    assert.match(line, /from=127\.0\.0\.1/)
  })

  it("names the permission a 403 was missing", () => {
    const line = refusalLine(
      request({ authorization: "Bearer abc.def" }, "/notes/n-1", "DELETE"),
      jsonBody({ _tag: "Forbidden", message: "your role is not allowed", needed: "notes:write" }, 403) as never,
    )
    assert.match(line, /status=403 method=DELETE route=\/notes\/n-1/)
    assert.match(line, /reason="your role is not allowed" needed=notes:write/)
  })

  it("never writes the token, only a stable handle of it", () => {
    const line = refusalLine(
      request({ authorization: "Bearer super-secret-token" }),
      jsonBody({ message: "expired token" }, 401) as never,
    )
    assert.ok(!line.includes("super-secret-token"), line)
    assert.ok(!line.includes("super-secret"), line)
    assert.equal(tokenHandle("Bearer super-secret-token"), tokenHandle("Bearer super-secret-token"))
    assert.notEqual(tokenHandle("Bearer a"), tokenHandle("Bearer b"))
    assert.equal(tokenHandle(undefined), "-")
    assert.match(line, /token=[0-9a-f]{12}/)
  })

  it("still says which of the two it was when the refusal states nothing", () => {
    const empty = { status: 401, body: { _tag: "Empty" as const } } as never
    assert.match(refusalLine(request(), empty), /reason="no token"/)
    assert.match(refusalLine(request({ authorization: "Bearer x" }), empty), /reason="token refused"/)
  })

  it("drops the query string, which is where credentials get logged by accident", () => {
    const line = refusalLine(request({}, "/notes?token=leak&page=2"), jsonBody({ message: "no token" }, 401) as never)
    assert.match(line, /route=\/notes /)
    assert.ok(!line.includes("leak"), line)
  })

  it("writes one line when the app refuses, and none when it does not", async () => {
    const run = async (response: HttpServerResponse.HttpServerResponse) => {
      const lines: Array<string> = []
      await Effect.runPromise(
        logRefusals(Effect.succeed(response)).pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request({ authorization: "Bearer tok" })),
          Effect.provide(
            Logger.replace(
              Logger.defaultLogger,
              Logger.make(({ message }) => lines.push(String(message))),
            ),
          ),
        ) as Effect.Effect<HttpServerResponse.HttpServerResponse, never, never>,
      )
      return lines
    }
    const refused = await run(HttpServerResponse.unsafeJson({ message: "unknown token" }, { status: 401 }))
    assert.equal(refused.length, 1)
    assert.match(refused[0] ?? "", /auth-refused status=401 .*reason="unknown token"/)
    assert.deepEqual(await run(HttpServerResponse.unsafeJson({ ok: true })), [])
  })
})
