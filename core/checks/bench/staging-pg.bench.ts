import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { bench, inject } from "vitest"
import { BENCH, STAGING_ROWS } from "../../tools/check/bench-budget-pure.ts"
import type { Session } from "../_layers/session.ts"
import { benchAdmin, okBody, runHttp } from "./client.ts"

// Replaces probes/staging-perf.mjs: 100,000 JSONL rows imported through the staging API in
// chunks of 1,000, then profiled. tools/check/bench-budget.ts turns the import median into rows per
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

/** Pure: how many rows the chunk starting at row `start` holds. */
const chunkSize = (start: number) => Math.min(CHUNK, STAGING_ROWS - start)

/** Pure: the JSONL text of the chunk starting at row `start`. */
const chunkText = (start: number) =>
  `${Array.from({ length: chunkSize(start) }, (_, k) => row(start + k)).join("\n")}\n`

const starts = Array.from({ length: Math.ceil(STAGING_ROWS / CHUNK) }, (_, n) => n * CHUNK)

// Anything but 200 fails the bench; a failed step is never timed as a fast one.
const post = (admin: Session, path: string, body?: unknown) => okBody(admin.send("POST", path, body), `POST ${path}`)

const createSet = (admin: Session) =>
  post(admin, "/staging/sets", { name: "bench", format: "jsonl", sourceFile: "bench.jsonl" }).pipe(
    Effect.flatMap(Schema.decodeUnknown(Created)),
    Effect.map(({ id }) => id),
  )

const sendChunk = (admin: Session, setId: string, start: number) =>
  post(admin, `/staging/sets/${setId}/chunks`, { text: chunkText(start), startLine: start + 1 }).pipe(
    Effect.flatMap(Schema.decodeUnknown(Parsed)),
    Effect.filterOrDie(
      ({ parsed }) => parsed === chunkSize(start),
      ({ parsed }) => new Error(`chunk at line ${start + 1}: ${parsed} rows parsed`),
    ),
  )

/** Creates a set, sends every chunk in order, finishes it; returns the set id. */
const importSet = (admin: Session) =>
  createSet(admin).pipe(
    Effect.tap((id) => Effect.forEach(starts, (start) => sendChunk(admin, id, start), { discard: true })),
    Effect.tap((id) => post(admin, `/staging/sets/${id}/finish`)),
  )

const admin = await benchAdmin(inject("benchServer").base)
// The profile bench reads the set the last import left behind.
let lastSet = ""
const remember = (id: string) => {
  lastSet = id
}

bench(BENCH.stagingImport, () => runHttp(importSet(admin)).then(remember), OPTIONS)

bench(
  "staging-pg profile 100k rows",
  () =>
    runHttp(
      Effect.asVoid(okBody(admin.get(`/staging/sets/${lastSet}/profile`), `GET /staging/sets/${lastSet}/profile`)),
    ),
  OPTIONS,
)
