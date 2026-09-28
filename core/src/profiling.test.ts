import { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Either } from "effect"
import { parseProfile } from "./config.ts"
import { resourcesMiddleware } from "./profiling.ts"
import { testConfig } from "./test-config.ts"

describe("QWBE_PROFILE", () => {
  it("defaults to requests when QWBE_TRACE_URL is set", () => {
    expect([...testConfig({ QWBE_TRACE_URL: "http://localhost:4318" }).profile]).toEqual(["requests"])
  })

  it("loads nothing without QWBE_TRACE_URL, whatever it says", () => {
    expect(testConfig({ QWBE_PROFILE: "requests,process" }).profile.size).toBe(0)
  })

  it("reads a comma list", () => {
    expect(parseProfile(" requests, resources,process")).toEqual(
      Either.right(new Set(["requests", "resources", "process"])),
    )
  })

  it("refuses an unknown name, naming it and the allowed ones", () => {
    expect(() => testConfig({ QWBE_TRACE_URL: "http://x", QWBE_PROFILE: "requests,cpu" })).toThrow(
      /unknown category "cpu"; allowed: requests, resources, process/,
    )
  })
})

describe("resources middleware", () => {
  it.effect("annotates the current span with the resource attributes", () =>
    Effect.gen(function* () {
      const app = resourcesMiddleware(HttpServerResponse.text("hello"))
      const request = HttpServerRequest.fromWeb(new Request("http://localhost/notes"))
      const span = yield* Effect.makeSpanScoped("http.server GET")
      yield* app.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request), Effect.withParentSpan(span))
      expect([...span.attributes.keys()].sort()).toEqual([
        "http.response.body.size",
        "qwbe.cpu.system_us",
        "qwbe.cpu.user_us",
        "qwbe.event_loop.utilization",
        "qwbe.heap.after",
        "qwbe.heap.before",
        "qwbe.heap.delta",
      ])
    }).pipe(Effect.scoped),
  )
})
