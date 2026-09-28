// Two QWBE_PROFILE categories on top of request spans (tracing.ts decides which load):
//
//   resources  what each request cost: CPU, heap and event-loop utilization, as attributes on
//              the request span.
//   process    whether the process leaks or starves over time: memory, GC, event-loop delay and
//              CPU gauges, sampled every 5 s and exported as OTLP metrics.

import { monitorEventLoopDelay, PerformanceObserver, performance } from "node:perf_hooks"
import { HttpMiddleware, type HttpServerResponse } from "@effect/platform"
import { Effect, Exit, Layer, Metric, Schedule } from "effect"

// --- resources ---

type Sample = {
  readonly cpu: NodeJS.CpuUsage
  readonly heap: number
  readonly elu: ReturnType<typeof performance.eventLoopUtilization>
}

const sample = Effect.sync(
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
  Effect.flatMap(sample, (before) =>
    app.pipe(
      Effect.onExit((exit) =>
        Effect.flatMap(sample, (after) =>
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

const nsToMs = (ns: number) => ns / 1e6

/** GC totals since the last `take`, plus heap used right after the most recent GC. */
const gcWatch = Effect.acquireRelease(
  Effect.sync(() => {
    const totals = { count: 0, pauseMs: 0, heapAfter: 0 }
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        totals.count += 1
        totals.pauseMs += entry.duration
      }
      totals.heapAfter = process.memoryUsage().heapUsed
    })
    observer.observe({ entryTypes: ["gc"] })
    const take = () => {
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

/** Every 5 s sets the qwbe.process.* gauges; lives as long as the server's scope. */
export const ProcessMetricsLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const gc = yield* gcWatch
    const loopDelay = yield* loopDelayWatch
    let last = { cpu: process.cpuUsage(), at: performance.now(), elu: performance.eventLoopUtilization() }

    const record = Effect.suspend(() => {
      const memory = process.memoryUsage()
      const gcTotals = gc.take()
      const now = { cpu: process.cpuUsage(), at: performance.now(), elu: performance.eventLoopUtilization() }
      const cpuUs = now.cpu.user - last.cpu.user + (now.cpu.system - last.cpu.system)
      const cpuPercent = (cpuUs / 1000 / (now.at - last.at)) * 100
      const elu = performance.eventLoopUtilization(now.elu, last.elu).utilization
      const delay = {
        p50: nsToMs(loopDelay.percentile(50)),
        p99: nsToMs(loopDelay.percentile(99)),
        max: nsToMs(loopDelay.max),
      }
      last = now
      loopDelay.reset()
      return Effect.all([
        Metric.set(gauges.heapUsed, memory.heapUsed),
        Metric.set(gauges.heapTotal, memory.heapTotal),
        Metric.set(gauges.rss, memory.rss),
        Metric.set(gauges.external, memory.external),
        Metric.set(gauges.arrayBuffers, memory.arrayBuffers),
        Metric.set(gauges.heapAfterGc, gcTotals.heapAfter),
        Metric.set(gauges.gcCount, gcTotals.count),
        Metric.set(gauges.gcPause, gcTotals.pauseMs),
        Metric.set(gauges.loopDelayP50, delay.p50),
        Metric.set(gauges.loopDelayP99, delay.p99),
        Metric.set(gauges.loopDelayMax, delay.max),
        Metric.set(gauges.loopUtilization, elu * 100),
        Metric.set(gauges.cpu, cpuPercent),
      ])
    })

    yield* Effect.forkScoped(Effect.repeat(record, Schedule.spaced("5 seconds")))
  }),
)
