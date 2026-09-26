import * as FetchHttpClient from "@effect/platform/FetchHttpClient"
import type * as HttpClient from "@effect/platform/HttpClient"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { bench, inject } from "vitest"
import { BENCH, STAGING_ROWS } from "../../tools/bench-budget-pure.ts"
import { type CallOptions, call, login } from "../_layers/api-client.ts"
import { USERS } from "../_layers/boot.ts"

// Replaces probes/staging-perf.mjs: 100,000 JSONL rows imported through the staging API in
// chunks of 1,000, then profiled. tools/bench-budget.ts turns the import median into rows per
// second and holds it to bench.stagingImport in qwbe.yaml; the profile is timed, not budgeted.

const CHUNK = 1_000
const CITIES = ["Timisoara", "Iasi", "Cluj", "Brasov", "Bucuresti"]

// Three imports of 100,000 rows each, no warm-up: one import is already minutes of work at worst.
const OPTIONS = { iterations: 3, time: 0, warmupIterations: 0, warmupTime: 0 }

const Created = Schema.Struct({ id: Schema.String })
const Parsed = Schema.Struct({ parsed: Schema.Number })

/** Pure: one deterministic JSONL line for row `i`. */
const row = (i: number) =>
  JSON.stringify({
    name: `Person ${i}`,
    email: `person${i}@example.com`,
    age: 20 + (i % 50),
    city: CITIES[i % CITIES.length],
    phone: `+40 7${i % 10}${String(i * 7919).padStart(7, "0")}`.slice(0, 13),
    joined: `202${i % 5}-0${1 + (i % 9)}-1${i % 9}`,
    note: i % 3 === 0 ? "customer asked for a callback about the open invoice" : "",
  })

const chunkText = (start: number) =>
  `${Array.from({ length: Math.min(CHUNK, STAGING_ROWS - start) }, (_, k) => row(start + k)).join("\n")}\n`

const run = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
  Effect.runPromise(Effect.provide(effect, FetchHttpClient.layer))

// Anything but 200 fails the bench; a failed step is never timed as a fast one.
const ok = (base: string, path: string, options: CallOptions) =>
  call(base, path, options).pipe(
    Effect.filterOrDie(
      (reply) => reply.status === 200,
      (reply) => new Error(`${options.method ?? "GET"} ${path} answered ${reply.status}`),
    ),
    Effect.map((reply) => reply.body),
  )

const sendChunk = (base: string, token: string, setId: string, start: number) =>
  ok(base, `/staging/sets/${setId}/chunks`, {
    method: "POST",
    token,
    body: { text: chunkText(start), startLine: start + 1 },
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(Parsed)),
    Effect.filterOrDie(
      ({ parsed }) => parsed === Math.min(CHUNK, STAGING_ROWS - start),
      ({ parsed }) => new Error(`chunk at line ${start + 1}: ${parsed} rows parsed`),
    ),
  )

const starts = Array.from({ length: Math.ceil(STAGING_ROWS / CHUNK) }, (_, n) => n * CHUNK)

/** Creates a set, sends every chunk in order, finishes it; returns the set id. */
const importSet = (base: string, token: string) =>
  ok(base, "/staging/sets", {
    method: "POST",
    token,
    body: { name: "bench", format: "jsonl", sourceFile: "bench.jsonl" },
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(Created)),
    Effect.map(({ id }) => id),
    Effect.tap((id) => Effect.forEach(starts, (start) => sendChunk(base, token, id, start), { discard: true })),
    Effect.tap((id) => ok(base, `/staging/sets/${id}/finish`, { method: "POST", token })),
  )

const { base } = inject("benchServer")
const token = await run(login(base, "admin", USERS.admin))
// The profile bench reads the set the last import left behind.
let lastSet = ""
const remember = (id: string) => {
  lastSet = id
}

bench(BENCH.stagingImport, () => run(importSet(base, token)).then(remember), OPTIONS)

bench(
  "staging-pg profile 100k rows",
  () => run(Effect.asVoid(ok(base, `/staging/sets/${lastSet}/profile`, { token }))),
  OPTIONS,
)
