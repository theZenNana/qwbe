import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { createTestDatabase } from "../../src/pg/test-db.ts"

export class TestDbUnavailable extends Data.TaggedError("TestDbUnavailable")<{ readonly cause: unknown }> {
  override get message() {
    return `could not create a test database (is Postgres up? npm run db:up): ${String(this.cause)}`
  }
}

/** A throwaway Postgres database for one test file. */
export class TestDb extends Context.Tag("TestDb")<TestDb, { readonly url: string }>() {}

// Bounded: a Postgres out of connections must fail this layer before vitest kills the worker,
// or the finalizers that stop servers and drop databases never run.
const create = (label: string) =>
  Effect.tryPromise({ try: () => createTestDatabase(label), catch: (cause) => new TestDbUnavailable({ cause }) }).pipe(
    Effect.timeoutFail({ duration: "20 seconds", onTimeout: () => new TestDbUnavailable({ cause: "timed out" }) }),
  )

const drop = (db: { readonly drop: () => Promise<void> }) =>
  Effect.promise(() => db.drop()).pipe(Effect.timeout("20 seconds"), Effect.ignore)

/** Creates `qwbe_test_<label>_<random>` and drops it WITH (FORCE) when the scope closes. */
export const testDb = (label: string) =>
  Layer.scoped(TestDb, Effect.acquireRelease(create(label), drop).pipe(Effect.map(({ url }) => ({ url }))))
