import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import pg from "pg"
import { closeAll, initStoreWith } from "../../src/pg/db.ts"
import { testConfigLayer } from "../../src/test-config.ts"

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

/** The kernel's own store on `url`, closed with the scope. */
export const kernelStore = (url: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({ try: () => initStoreWith(testConfigLayer({ QWBE_DATABASE_URL: url })), catch: failed }),
    () => Effect.promise(closeAll),
  )
