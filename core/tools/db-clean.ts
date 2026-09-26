// `db clean`: drops the test databases killed runs leaked, over one admin connection.
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import pg from "pg"
import { cleanSummary, dropStatement, LEAK_PREFIXES, leakSearch } from "./db-pure.ts"

class DbFailed extends Data.TaggedError("DbFailed")<{ readonly message: string }> {}

const failed = (error: unknown) => new DbFailed({ message: `db clean: ${String(error)}` })

const connect = (url: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const client = new pg.Client({ connectionString: url })
        await client.connect()
        return client
      },
      catch: failed,
    }),
    (client) => Effect.ignore(Effect.tryPromise(() => client.end())),
  )

const query = (client: pg.Client, text: string, values: ReadonlyArray<string>) =>
  Effect.tryPromise({ try: () => client.query<{ datname: string }>(text, [...values]), catch: failed })

const findLeaks = (client: pg.Client) => {
  const { text, values } = leakSearch(LEAK_PREFIXES)
  return Effect.map(query(client, text, values), ({ rows }) => rows.map((row) => row.datname))
}

const drop = (client: pg.Client, name: string) =>
  query(client, dropStatement(name), []).pipe(Effect.zipRight(Console.log(`db clean: dropped ${name}`)))

export const clean = (url: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* connect(url)
      const names = yield* findLeaks(client)
      yield* Effect.forEach(names, (name) => drop(client, name), { discard: true })
      yield* Console.log(cleanSummary(names.length))
    }),
  )
