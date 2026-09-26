import { expect, layer } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import pg from "pg"
import { fieldStats } from "../../src/cubes/staging/profile.ts"
import { shapeOf } from "../../src/cubes/staging/shapes.ts"
import { TestDb, testDb } from "../_layers/test-db.ts"

// Replaces the drift check of probes/staging.mjs: the same pattern sources feed JS RegExp in
// shapeOf and SQL `~` in fieldStats, and only Postgres can say whether both dialects read them
// the same way. The HTTP import and profile flow of that probe is not ported here.
//
// The probe's rows plus edge values: a digit string that could be a phone, a negative decimal
// as text, a timestamp, a broken email, an email with a space (`\s` inside brackets), a
// parenthesised phone, a two-digit number, a slash date, an empty string and a JSON null.
const RECORDS: ReadonlyArray<Readonly<Record<string, unknown>>> = [
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
  { name: "Ana", email: "a b@example.com", joined: "2024-01-02 10:20" },
]
const SET = "shapes-set"
const FIELDS = [...new Set(RECORDS.flatMap(Object.keys))]
const SPECIFIC = ["number", "date", "email", "phone"] as const

/** Filled values of one field and how many fall in each specific shape; `text` is the leftover. */
type Counts = Record<"filled" | (typeof SPECIFIC)[number], number>

const countOf = (shapes: ReadonlyArray<string>, shape: string) => shapes.filter((s) => s === shape).length

/** The JS detector over one field of the set. */
const jsCounts = (field: string): Counts => {
  const shapes = RECORDS.map((record) => shapeOf(record[field])).filter((shape) => shape !== null)
  return {
    filled: shapes.length,
    number: countOf(shapes, "number"),
    date: countOf(shapes, "date"),
    email: countOf(shapes, "email"),
    phone: countOf(shapes, "phone"),
  }
}

/** The same counts read from one fieldStats row. */
const sqlCounts = (row: Readonly<Record<string, number>>): Counts => ({
  filled: row.filled ?? 0,
  number: row.number_count ?? 0,
  date: row.date_count ?? 0,
  email: row.email_count ?? 0,
  phone: row.phone_count ?? 0,
})

const connect = (url: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const client = new pg.Client({ connectionString: url })
      await client.connect()
      return client
    }),
    (client) => Effect.promise(() => client.end()),
  )

/** The set as the staging cube stores it: a "rows" table, fieldStats reads it unqualified. */
const loadSet = (client: pg.Client) =>
  Effect.promise(async () => {
    await client.query(`CREATE TABLE "rows" (deleted boolean NOT NULL DEFAULT false, body jsonb NOT NULL)`)
    for (const record of RECORDS) {
      await client.query(`INSERT INTO "rows" (body) VALUES ($1)`, [JSON.stringify({ setId: SET, record })])
    }
  })

const profileField = (client: pg.Client, field: string) => {
  const { text, values = [] } = fieldStats(field, SET)
  return Effect.promise(() => client.query<Record<string, number>>(text, [...values])).pipe(
    Effect.map((result) => sqlCounts(result.rows[0] ?? {})),
  )
}

/** The SQL profile of one field of the loaded set. */
class SqlProfile extends Context.Tag("SqlProfile")<SqlProfile, (field: string) => Effect.Effect<Counts>>() {}

const sqlProfile = Layer.scoped(
  SqlProfile,
  Effect.gen(function* () {
    const { url } = yield* TestDb
    const client = yield* connect(url)
    yield* loadSet(client)
    return (field: string) => profileField(client, field)
  }),
).pipe(Layer.provide(testDb("shapes")))

layer(sqlProfile, { timeout: 60_000, excludeTestServices: true })("staging shape detection", (it) => {
  it.effect("JS shapeOf and SQL ~ count every field of the set the same way", () =>
    Effect.gen(function* () {
      const profileOf = yield* SqlProfile
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
