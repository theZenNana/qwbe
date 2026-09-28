// Opt-in, dev-only telemetry export over OTLP/HTTP to a local collector. QWBE_TRACE_URL unset
// means nothing here is built: no cost, no spans, no metrics. QWBE_PROFILE picks what loads:
//
//   requests   every Effect span -- the per-request span from @effect/platform, one per SQL
//              statement from @effect/sql/PgClient, one per Effect.fn / Effect.withSpan -- plus
//              the qwbe.http.request.duration histogram (profiling.ts), exported as OTLP metrics.
//   resources  CPU / heap / event-loop attributes on each request span (profiling.ts); it
//              rides on the request spans, so it loads the span exporter too.
//   process    qwbe.process.* gauges every 5 s (profiling.ts), exported as OTLP metrics.
//
// To see them: `docker compose --profile trace up -d lgtm`, open Grafana at
// http://localhost:3300 (QWBE_GRAFANA_PORT), Explore -> Tempo for service "qwbe", Prometheus
// for qwbe_http_request_duration_* and qwbe_process_*.

import { OtlpMetrics, OtlpSerialization, OtlpTracer } from "@effect/opentelemetry"
import { FetchHttpClient, HttpApp, HttpServerResponse } from "@effect/platform"
import { Effect, Layer } from "effect"
import { type ProfileCategory, QwbeConfig } from "./config.ts"
import { ProcessMetricsLive } from "./profiling.ts"

const resource = { serviceName: "qwbe" }

/** Whether request spans are exported: `requests`, or `resources`, which annotates them. */
export const exportsSpans = (profile: ReadonlySet<ProfileCategory>) =>
  profile.has("requests") || profile.has("resources")

/** Whether metrics are exported: `requests` records the duration histogram, `process` the gauges. */
export const exportsMetrics = (profile: ReadonlySet<ProfileCategory>) =>
  profile.has("requests") || profile.has("process")

/** The exporters for the chosen categories; `Layer.empty` when none is on. */
export const telemetryLayer = (traceUrl: string | undefined, profile: ReadonlySet<ProfileCategory>) => {
  if (traceUrl === undefined) return Layer.empty
  const spans = exportsSpans(profile) ? OtlpTracer.layer({ url: `${traceUrl}/v1/traces`, resource }) : Layer.empty
  const metrics = exportsMetrics(profile) ? OtlpMetrics.layer({ url: `${traceUrl}/v1/metrics`, resource }) : Layer.empty
  const gauges = profile.has("process") ? ProcessMetricsLive : Layer.empty
  return Layer.mergeAll(spans, metrics, gauges).pipe(
    Layer.provide(OtlpSerialization.layerJson),
    Layer.provide(FetchHttpClient.layer),
  )
}

export const TracingLive = Layer.unwrapEffect(
  Effect.map(QwbeConfig, ({ traceUrl, profile }) => telemetryLayer(traceUrl, profile)),
)

export const traceIdHeader = <E, R>(app: HttpApp.Default<E, R>): HttpApp.Default<E, R> =>
  app.pipe(
    // A pre-response handler runs BEFORE the server writes the response to the socket, and in
    // the same fiber as the request handler -- so the current span there is the request span.
    // A middleware that set the header after `app` completes would be too late: the response is
    // already written by then.
    HttpApp.withPreResponseHandler((_request, response) =>
      Effect.matchEffect(Effect.currentSpan, {
        onFailure: () => Effect.succeed(response),
        onSuccess: (span) => Effect.succeed(HttpServerResponse.setHeader(response, "x-trace-id", span.traceId)),
      }),
    ),
  )
