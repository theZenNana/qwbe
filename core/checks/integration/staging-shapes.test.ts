import { expect, layer } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import pg from "pg"
import { fieldStats } from "../../src/cubes/staging/profile.ts"
import { shapeOf } from "../../src/cubes/staging/shapes.ts"
import { TestDb, testDb } from "../_layers/test-db.ts"

// The probe's set plus edge values: a digit string that could be a phone, a timestamp,
// a broken email, a parenthesised phone, an empty string and a JSON null.
const RECORDS: ReadonlyArray<Record<string, unknown>> = [
  {
    name: "Ioana Pop",
    email: "ioana@example.com",
    age: 31,
    city: "Timisoara",
    phone: "+40 722 111 222",
    joined: "2024-01-02",
  },
  { name: "Dan Ionescu", email: "dan@example.com", age: 44, city: "Timisoara", phone: "0722 111 222" },
  { name: "Maria Dima", email: "maria@example.com", city: "Iasi", joined: "2024-05-06" },
  {
    name: "12345",
    email: "not-an-email@",
    age: "-3.25",
    city: "",
    phone: "(0722) 111-222",
    joined: "2024-01-02T10:20:30Z",
  },
  { name: "a@b.co", email: null, age: "forty", phone: "12", joined: "02/01/2024" },
]
const SET = "shapes-set"
const FIELDS = [...new Set(RECORDS.flatMap(Object.keys))]
const SPECIFIC = ["number", "date", "email", "phone"] as const

/** How many values of one field are filled, and how many fall in each specific shape. */
type Counts = Record<"filled" | (typeof SPECIFIC)[number], number>

/** The JS detector over one field; `text` is the leftover bucket and is not compared. */
const jsCounts = (field: string): Counts => {
  const shapes = RECORDS.map((record) => shapeOf(record[field])).filter((shape) => shape !== null)
  const count = (shape: string) => shapes.filter((s) => s === shape).length
  return {
    filled: shapes.length,
    number: count("number"),
    date: count("date"),
    email: count("email"),
    phone: count("phone"),
  }
}

/** The same counts read from one fieldStats row. */
const sqlCounts = (row: Record<string, number>): Counts => ({
  filled: row.filled ?? 0,
  number: row.number_count ?? 0,
  date: row.date_count ?? 0,
  email: row.email_count ?? 0,
  phone: row.phone_count ?? 0,
})

/** The set loaded into a "rows" table (fieldStats reads it unqualified) and profiled one field at a time. */
class Profile extends Context.Tag("Profile")<Profile, (field: string) => Effect.Effect<Counts>>() {}
const profile = Layer.scoped(
  Profile,
  Effect.gen(function* () {
    const { url } = yield* TestDb
    const client = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const client = new pg.Client({ connectionString: url })
        await client.connect()
        await client.query(`CREATE TABLE "rows" (deleted boolean NOT NULL DEFAULT false, body jsonb NOT NULL)`)
        for (const record of RECORDS) {
          await client.query(`INSERT INTO "rows" (body) VALUES ($1)`, [JSON.stringify({ setId: SET, record })])
        }
        return client
      }),
      (client) => Effect.promise(() => client.end()),
    )
    return (field: string) => {
      const { text, values = [] } = fieldStats(field, SET)
      return Effect.promise(() => client.query<Record<string, number>>(text, [...values])).pipe(
        Effect.map((result) => sqlCounts(result.rows[0] ?? {})),
      )
    }
  }),
).pipe(Layer.provide(testDb("shapes")))

layer(profile, { timeout: 60_000, excludeTestServices: true })((it) => {
  it.effect("JS shapeOf and the SQL ~ match count every field of the set the same way", () =>
    Effect.gen(function* () {
      const profileOf = yield* Profile
      for (const field of FIELDS) {
        expect({ field, ...(yield* profileOf(field)) }).toEqual({ field, ...jsCounts(field) })
      }
    }),
  )

  it.effect("the set exercises every specific shape, so agreement is not vacuous", () =>
    Effect.sync(() => {
      for (const shape of SPECIFIC) expect(FIELDS.some((field) => jsCounts(field)[shape] > 0)).toBe(true)
    }),
  )
})
