// Three QWBE_PROFILE categories on top of request spans (tracing.ts decides which load):
//
//   requests   the owning cube on each request span, and a qwbe.http.request.duration histogram
//              by cube, route, method and status class, exported as OTLP metrics.
//   resources  what each request cost: CPU, heap and event-loop utilization, as attributes on
//              the request span.
//   process    whether the process leaks or starves over time: memory, GC, event-loop delay and
//              CPU gauges, sampled every 5 s and exported as OTLP metrics.
//
// Pure decisions (attributes, labels, readings) are kept apart from the I/O that feeds them.

import { monitorEventLoopDelay, PerformanceObserver, performance } from "node:perf_hooks"
import { HttpMiddleware, HttpServerError, HttpServerRequest, type HttpServerResponse } from "@effect/platform"
import { Effect, Exit, Layer, Metric, MetricBoundaries, Schedule } from "effect"

// --- requests ---

/** 1 ms .. 4096 ms, doubling; slower requests land in the +Inf bucket. */
export const requestDuration = Metric.histogram(
  "qwbe.http.request.duration",
  MetricBoundaries.exponential({ start: 1, factor: 2, count: 13 }),
  "Request duration in milliseconds",
)

/** `200` -> `2xx`. */
export const statusClass = (status: number) => `${Math.floor(status / 100)}xx`

/** The route template the router put on the span; `unmatched` when no route matched. */
export const routeLabel = (route: unknown) => (typeof route === "string" ? route : "unmatched")

export type RequestLabels = { cube: string; route: string; method: string; status: string }

/** The histogram labels for one finished request. */
export const requestLabels = (
  cube: string | undefined,
  route: unknown,
  method: string,
  status: number,
): RequestLabels => ({ cube: cube ?? "none", route: routeLabel(route), method, status: statusClass(status) })

const recordDuration = (labels: RequestLabels, ms: number) =>
  Metric.update(
    requestDuration.pipe(
      Metric.tagged("cube", labels.cube),
      Metric.tagged("route", labels.route),
      Metric.tagged("method", labels.method),
      Metric.tagged("status", labels.status),
    ),
    ms,
  )

/**
 * Puts `qwbe.cube` on the request span and records one duration sample per request.
 * `cubeOf` maps a request URL to the cube that owns it (undefined for spec, health).
 */
export const requestsMiddleware = (cubeOf: (url: string) => string | undefined) =>
  HttpMiddleware.make((app) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const cube = cubeOf(request.url)
      if (cube !== undefined) yield* Effect.annotateCurrentSpan("qwbe.cube", cube)
      const start = performance.now()
      return yield* app.pipe(
        Effect.onExit((exit) =>
          Effect.flatMap(Effect.currentSpan.pipe(Effect.option), (span) => {
            const route = span._tag === "Some" ? span.value.attributes.get("http.route") : undefined
            const status = HttpServerError.exitResponse(exit).status
            return recordDuration(requestLabels(cube, route, request.method, status), performance.now() - start)
          }),
        ),
      )
    }),
  )

// --- resources ---

type Sample = {
  readonly cpu: NodeJS.CpuUsage
  readonly heap: number
  readonly elu: ReturnType<typeof performance.eventLoopUtilization>
}

const readSample = Effect.sync(
  (): Sample => ({
    cpu: process.cpuUsage(),
    heap: process.memoryUsage().heapUsed,
    elu: performance.eventLoopUtilization(),
  }),
)

/** The span attributes for one request, from the readings taken around its handler. */
export const resourceAttributes = (
  before: Sample,
  after: Sample,
  response: HttpServerResponse.HttpServerResponse | undefined,
): Record<string, number> => {
  const bodySize = response?.body._tag === "Uint8Array" ? response.body.contentLength : undefined
  return {
    "qwbe.cpu.user_us": after.cpu.user - before.cpu.user,
    "qwbe.cpu.system_us": after.cpu.system - before.cpu.system,
    "qwbe.heap.before": before.heap,
    "qwbe.heap.after": after.heap,
    "qwbe.heap.delta": after.heap - before.heap,
    "qwbe.event_loop.utilization": performance.eventLoopUtilization(after.elu, before.elu).utilization,
    ...(bodySize === undefined ? {} : { "http.response.body.size": bodySize }),
  }
}

// These are process-wide readings: with concurrent requests they overlap, not per request.
export const resourcesMiddleware = HttpMiddleware.make((app) =>
  Effect.flatMap(readSample, (before) =>
    app.pipe(
      Effect.onExit((exit) =>
        Effect.flatMap(readSample, (after) =>
          Effect.annotateCurrentSpan(resourceAttributes(before, after, Exit.isSuccess(exit) ? exit.value : undefined)),
        ),
      ),
    ),
  ),
)

// --- process ---

const gauges = {
  heapUsed: Metric.gauge("qwbe.process.heap_used_bytes"),
  heapTotal: Metric.gauge("qwbe.process.heap_total_bytes"),
  rss: Metric.gauge("qwbe.process.rss_bytes"),
  external: Metric.gauge("qwbe.process.external_bytes"),
  arrayBuffers: Metric.gauge("qwbe.process.array_buffers_bytes"),
  heapAfterGc: Metric.gauge("qwbe.process.heap_after_gc_bytes"),
  gcCount: Metric.gauge("qwbe.process.gc_count"),
  gcPause: Metric.gauge("qwbe.process.gc_pause_ms"),
  loopDelayP50: Metric.gauge("qwbe.process.event_loop_delay_p50_ms"),
  loopDelayP99: Metric.gauge("qwbe.process.event_loop_delay_p99_ms"),
  loopDelayMax: Metric.gauge("qwbe.process.event_loop_delay_max_ms"),
  loopUtilization: Metric.gauge("qwbe.process.event_loop_utilization_percent"),
  cpu: Metric.gauge("qwbe.process.cpu_percent"),
}

type GcTotals = { count: number; pauseMs: number; heapAfter: number }

/** GC totals since the last `take`, plus heap used right after the most recent GC. */
const gcWatch = Effect.acquireRelease(
  Effect.sync(() => {
    const totals: GcTotals = { count: 0, pauseMs: 0, heapAfter: 0 }
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        totals.count += 1
        totals.pauseMs += entry.duration
      }
      totals.heapAfter = process.memoryUsage().heapUsed
    })
    observer.observe({ entryTypes: ["gc"] })
    const take = (): GcTotals => {
      const taken = { ...totals }
      totals.count = 0
      totals.pauseMs = 0
      return taken
    }
    return { observer, take }
  }),
  ({ observer }) => Effect.sync(() => observer.disconnect()),
)

const loopDelayWatch = Effect.acquireRelease(
  Effect.sync(() => {
    const histogram = monitorEventLoopDelay({ resolution: 20 })
    histogram.enable()
    return histogram
  }),
  (histogram) => Effect.sync(() => histogram.disable()),
)

type ProcessSample = {
  readonly cpu: NodeJS.CpuUsage
  readonly at: number
  readonly elu: ReturnType<typeof performance.eventLoopUtilization>
}

const readProcessSample = (): ProcessSample => ({
  cpu: process.cpuUsage(),
  at: performance.now(),
  elu: performance.eventLoopUtilization(),
})

type LoopDelayMs = { p50: number; p99: number; max: number }

const nsToMs = (ns: number) => ns / 1e6

/** Reads and resets the event-loop delay histogram. */
const takeLoopDelay = (histogram: ReturnType<typeof monitorEventLoopDelay>): LoopDelayMs => {
  const delay = {
    p50: nsToMs(histogram.percentile(50)),
    p99: nsToMs(histogram.percentile(99)),
    max: nsToMs(histogram.max),
  }
  histogram.reset()
  return delay
}

/** CPU percent and event-loop utilization percent between two samples. */
const processLoad = (last: ProcessSample, now: ProcessSample) => {
  const cpuUs = now.cpu.user - last.cpu.user + (now.cpu.system - last.cpu.system)
  return {
    cpuPercent: (cpuUs / 1000 / (now.at - last.at)) * 100,
    eluPercent: performance.eventLoopUtilization(now.elu, last.elu).utilization * 100,
  }
}

const setGauges = (
  memory: NodeJS.MemoryUsage,
  gc: GcTotals,
  delay: LoopDelayMs,
  load: ReturnType<typeof processLoad>,
) =>
  Effect.all([
    Metric.set(gauges.heapUsed, memory.heapUsed),
    Metric.set(gauges.heapTotal, memory.heapTotal),
    Metric.set(gauges.rss, memory.rss),
    Metric.set(gauges.external, memory.external),
    Metric.set(gauges.arrayBuffers, memory.arrayBuffers),
    Metric.set(gauges.heapAfterGc, gc.heapAfter),
    Metric.set(gauges.gcCount, gc.count),
    Metric.set(gauges.gcPause, gc.pauseMs),
    Metric.set(gauges.loopDelayP50, delay.p50),
    Metric.set(gauges.loopDelayP99, delay.p99),
    Metric.set(gauges.loopDelayMax, delay.max),
    Metric.set(gauges.loopUtilization, load.eluPercent),
    Metric.set(gauges.cpu, load.cpuPercent),
  ])

/** Every 5 s sets the qwbe.process.* gauges; lives as long as the server's scope. */
export const ProcessMetricsLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const gc = yield* gcWatch
    const loopDelay = yield* loopDelayWatch
    let last = readProcessSample()
    const record = Effect.suspend(() => {
      const now = readProcessSample()
      const load = processLoad(last, now)
      last = now
      return setGauges(process.memoryUsage(), gc.take(), takeLoopDelay(loopDelay), load)
    })
    yield* Effect.forkScoped(Effect.repeat(record, Schedule.spaced("5 seconds")))
  }),
)
