import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import pg from "pg"
import { closeAll, initStore } from "../../src/pg/db.ts"

export class PostgresFailed extends Data.TaggedError("PostgresFailed")<{ readonly cause: unknown }> {
  override get message() {
    return `postgres: ${String(this.cause)}`
  }
}

const failed = (cause: unknown) => new PostgresFailed({ cause })

/** One client on `url`, ended when the scope closes. */
export const connect = (url: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const client = new pg.Client({ connectionString: url })
        await client.connect()
        return client
      },
      catch: failed,
    }),
    (client) => Effect.promise(() => client.end()),
  )

export const query = (client: pg.Client, text: string) =>
  Effect.tryPromise({ try: () => client.query(text), catch: failed })

// ponytail: the pool reads QWBE_DATABASE_URL from the environment when it is built, so the url
// still goes through process.env; an initStore(url) in src/pg/db.ts removes this once the config
// rewrite lands.
/** The kernel's own store on `url`, closed with the scope. */
export const kernelStore = (url: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => {
        process.env.QWBE_DATABASE_URL = url
        return initStore()
      },
      catch: failed,
    }),
    () => Effect.promise(closeAll),
  )
