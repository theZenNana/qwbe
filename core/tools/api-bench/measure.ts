// The timing of the API benchmark: one request sent and timed, and the warm-up plus the runs at
// concurrency 1 and 20 of one route.
import { resolve } from "node:path"
import * as Console from "effect/Console"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type { Session } from "../../checks/_layers/session.ts"
import { send as sendRequest } from "../../src/api-client.ts"
import type { ApiBench, Fixture } from "../shared/config.ts"
import { type Method, numbered, type Route, urlOf } from "./routes.ts"
import { type Result, type Sample, type Stats, statsOf, TIMEOUT } from "./stats.ts"

/** The repo root, which `{root}` in a fixture becomes. */
export const ROOT = resolve(import.meta.dirname, "../../..")

export type Sessions = Readonly<Record<"admin" | "reader", Session>>

interface Request {
  readonly user: keyof Sessions
  readonly method: Method
  readonly url: string
  readonly body: unknown
}

/** Request `n` of a route: the fixture numbered, its params and query in the URL. */
const requestOf = ({ method, path }: Pick<Route, "method" | "path">, fixture: typeof Fixture.Type, n: number) => {
  const { user = "admin", body, ...rest } = numbered(fixture, n, ROOT)
  return { user, method, url: urlOf(path, rest), body } satisfies Request
}

const logTimeout = ({ method, url, user, body }: Request) =>
  Console.log(`  timeout: ${method} ${url} as ${user}, body ${JSON.stringify(body ?? null)}`)

// A timeout answers TIMEOUT and names the request; any other transport failure still dies.
const sendAs = ({ base, token }: Session, request: Request) =>
  sendRequest(base, request.url, { method: request.method, token, body: request.body }).pipe(
    Effect.catchTag("TimeoutException", () => Effect.as(logTimeout(request), { status: TIMEOUT, body: undefined })),
    Effect.orDie,
  )

/** Request `n` of a route, sent as the fixture's user. */
export const send = (
  sessions: Sessions,
  route: Pick<Route, "method" | "path">,
  fixture: typeof Fixture.Type,
  n: number,
) => {
  const request = requestOf(route, fixture, n)
  return sendAs(sessions[request.user], request)
}

const timed = <R>(request: Effect.Effect<{ readonly status: number }, never, R>) =>
  Effect.map(Effect.timed(request), ([took, { status }]): Sample => ({ ms: Duration.toMillis(took), status }))

// `from` numbers the requests, so `{n}` never repeats across warm-up and both runs; 0 is the seed's create.
const run = <R>(
  request: (n: number) => Effect.Effect<Sample, never, R>,
  count: number,
  concurrency: number,
  from: number,
) =>
  Effect.map(
    Effect.timed(
      Effect.forEach(
        Array.from({ length: count }, (_, i) => from + i),
        request,
        { concurrency },
      ),
    ),
    ([wall, samples]) => statsOf(samples, Duration.toMillis(wall)),
  )

const logP99 = (key: string, c1: Stats, c20: Stats) =>
  Console.log(`  ${key}: p99 ${c1.p99.toFixed(1)} ms at c1, ${c20.p99.toFixed(1)} ms at c20`)

export const benchRoute = (
  sessions: Sessions,
  route: Route,
  fixture: typeof Fixture.Type,
  requests: typeof ApiBench.Type.requests,
) =>
  Effect.gen(function* () {
    const request = (n: number) => timed(send(sessions, route, fixture, n))
    yield* run(request, requests.warmup, 1, 1)
    const c1 = yield* run(request, requests.c1, 1, 1 + requests.warmup)
    const c20 = yield* run(request, requests.c20, 20, 1 + requests.warmup + requests.c1)
    yield* logP99(route.key, c1, c20)
    return { key: route.key, cube: route.cube, c1, c20 } satisfies Result
  })
