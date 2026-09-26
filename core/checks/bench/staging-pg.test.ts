import { expect, layer } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { call, login } from "../_layers/api-client.ts"
import { benchLine, budgets } from "../_layers/measure.ts"
import { TestServer, testServer, USERS } from "../_layers/test-server.ts"

// Importing 100,000 JSONL rows through the staging API keeps at least the rows per second in
// qwbe.yaml (bench.stagingImport); the profile afterwards answers.
const TOTAL = 100_000
const CHUNK = 1_000
const CITIES = ["Timisoara", "Iasi", "Cluj", "Brasov", "Bucuresti"]

/** Pure: one deterministic JSONL line for row `i`. */
export const row = (i: number) =>
  JSON.stringify({
    name: `Person ${i}`,
    email: `person${i}@example.com`,
    age: 20 + (i % 50),
    city: CITIES[i % CITIES.length],
    joined: `202${i % 5}-0${1 + (i % 9)}-1${i % 9}`,
  })

const chunkText = (start: number) =>
  `${Array.from({ length: Math.min(CHUNK, TOTAL - start) }, (_, k) => row(start + k)).join("\n")}\n`

const importAll = (base: string, token: string, setId: string) =>
  Effect.forEach(
    Array.from({ length: TOTAL / CHUNK }, (_, n) => n * CHUNK),
    (start) =>
      call(base, `/staging/sets/${setId}/chunks`, {
        method: "POST",
        token,
        body: { text: chunkText(start), startLine: start + 1 },
      }).pipe(
        Effect.filterOrDie(
          (reply) => reply.status === 200,
          (reply) => new Error(`chunk at ${start}: ${reply.status}`),
        ),
      ),
    { discard: true },
  )

layer(testServer("bench-staging"), { timeout: 300_000, excludeTestServices: true })((it) => {
  it.effect(
    "imports 100,000 rows at the budgeted rate and profiles them",
    () =>
      Effect.gen(function* () {
        const { base } = yield* TestServer
        const minRate = (yield* budgets).stagingImport.minRowsPerSecond
        const token = yield* login(base, "admin", USERS.admin)
        const created = yield* call(base, "/staging/sets", {
          method: "POST",
          token,
          body: { name: "bench", format: "jsonl", sourceFile: "bench.jsonl" },
        })
        const setId = (created.body as { id: string }).id
        const [elapsed] = yield* Effect.timed(importAll(base, token, setId))
        yield* call(base, `/staging/sets/${setId}/finish`, { method: "POST", token })
        const rate = TOTAL / (Duration.toMillis(elapsed) / 1000)
        yield* benchLine(`staging-pg import: ${Math.round(rate)} rows/s over ${TOTAL} rows`)
        expect(rate).toBeGreaterThan(minRate)
        expect((yield* call(base, `/staging/sets/${setId}/profile`, { token })).status).toBe(200)
      }),
    300_000,
  )
})
