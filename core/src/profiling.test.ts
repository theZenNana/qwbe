import { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Either, Metric } from "effect"
import { parseProfile } from "./config.ts"
import {
  requestDuration,
  requestLabels,
  requestsMiddleware,
  resourceAttributes,
  resourcesMiddleware,
  routeLabel,
  statusClass,
} from "./profiling.ts"
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

describe("request labels", () => {
  it("turns a status into its class", () => {
    expect([200, 204, 404, 500].map(statusClass)).toEqual(["2xx", "2xx", "4xx", "5xx"])
  })

  it("falls back to unmatched when the router set no route", () => {
    expect(routeLabel(undefined)).toBe("unmatched")
    expect(routeLabel("/notes/:id")).toBe("/notes/:id")
  })

  it("builds the four labels, cube none outside any cube", () => {
    expect(requestLabels(undefined, undefined, "GET", 200)).toEqual({
      cube: "none",
      route: "unmatched",
      method: "GET",
      status: "2xx",
    })
  })
})

describe("requests middleware", () => {
  it.effect("tags the span with the cube and records one histogram sample", () =>
    Effect.gen(function* () {
      const handler = Effect.zipRight(
        Effect.flatMap(Effect.currentSpan, (span) => Effect.sync(() => span.attribute("http.route", "/probe/:id"))),
        HttpServerResponse.text("hi", { status: 201 }),
      )
      const app = requestsMiddleware((url) => (url.startsWith("/probe") ? "probe" : undefined))(handler)
      const request = HttpServerRequest.fromWeb(new Request("http://localhost/probe/1", { method: "POST" }))
      const span = yield* Effect.makeSpanScoped("http.server POST")
      yield* app.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request), Effect.withParentSpan(span))
      expect(span.attributes.get("qwbe.cube")).toBe("probe")
      const state = yield* Metric.value(
        requestDuration.pipe(
          Metric.tagged("cube", "probe"),
          Metric.tagged("route", "/probe/:id"),
          Metric.tagged("method", "POST"),
          Metric.tagged("status", "2xx"),
        ),
      )
      expect(state.count).toBe(1)
    }).pipe(Effect.scoped),
  )
})

describe("resource attributes", () => {
  it("diffs two samples and adds the body size", () => {
    const before = { cpu: { user: 100, system: 10 }, heap: 1000, elu: { idle: 0, active: 0, utilization: 0 } }
    const after = { cpu: { user: 150, system: 30 }, heap: 1400, elu: { idle: 50, active: 50, utilization: 0.5 } }
    expect(resourceAttributes(before, after, HttpServerResponse.text("hello"))).toEqual({
      "qwbe.cpu.user_us": 50,
      "qwbe.cpu.system_us": 20,
      "qwbe.heap.before": 1000,
      "qwbe.heap.after": 1400,
      "qwbe.heap.delta": 400,
      "qwbe.event_loop.utilization": 0.5,
      "http.response.body.size": 5,
    })
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
