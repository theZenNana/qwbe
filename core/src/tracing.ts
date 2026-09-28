// Opt-in, dev-only span export. Every Effect span the server creates -- the per-request
// span from @effect/platform, one per SQL statement from @effect/sql/PgClient, one per
// Effect.fn / Effect.withSpan with the call-site stack -- is sent over OTLP/HTTP to a local
// collector. QWBE_TRACE_URL unset means no tracer is built at all: no cost, no spans.
//
// To see the traces: `docker compose --profile trace up -d jaeger`, then open the Jaeger UI
// at http://localhost:16686 and pick service "qwbe".

import { OtlpSerialization, OtlpTracer } from "@effect/opentelemetry"
import { FetchHttpClient, HttpApp, HttpServerResponse } from "@effect/platform"
import { Effect, Layer } from "effect"
import { QwbeConfig } from "./config.ts"

/** Builds the OTLP/HTTP exporter only when `traceUrl` is set; `Layer.empty` otherwise. */
export const TracingLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const { traceUrl } = yield* QwbeConfig
    return traceUrl === undefined
      ? Layer.empty
      : OtlpTracer.layer({ url: `${traceUrl}/v1/traces`, resource: { serviceName: "qwbe" } }).pipe(
          Layer.provide(OtlpSerialization.layerJson),
          Layer.provide(FetchHttpClient.layer),
        )
  }),
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
