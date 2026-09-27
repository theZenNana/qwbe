import * as Effect from "effect/Effect"
import pg from "pg"
import { closeAll, initStore } from "../../src/pg/db.ts"

/** One client on `url`, ended when the scope closes. */
export const connect = (url: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const client = new pg.Client({ connectionString: url })
      await client.connect()
      return client
    }),
    (client) => Effect.promise(() => client.end()),
  )

export const query = (client: pg.Client, text: string) => Effect.promise(() => client.query(text))

/** The kernel's own store on `url`, closed with the scope: env first, its pool reads it lazily. */
export const kernelStore = (url: string) =>
  Effect.acquireRelease(
    Effect.promise(() => {
      process.env.QWBE_DATABASE_URL = url
      return initStore()
    }),
    () => Effect.promise(closeAll),
  )
