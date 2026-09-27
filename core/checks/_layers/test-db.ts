import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { testDatabase } from "../../src/pg/test-db.ts"

export class TestDbUnavailable extends Data.TaggedError("TestDbUnavailable")<{ readonly cause: unknown }> {
  override get message() {
    return `could not create a test database (is Postgres up? npm run db:up): ${String(this.cause)}`
  }
}

/** A throwaway Postgres database for one test file. */
export class TestDb extends Context.Tag("TestDb")<TestDb, { readonly url: string }>() {}

/**
 * Creates `qwbe_test_<label>_<random>` and drops it WITH (FORCE) when the scope closes.
 * Bounded: a Postgres out of connections must fail this layer before vitest kills the worker,
 * or the finalizers that stop servers and drop databases never run.
 */
export const testDb = (label: string) =>
  Layer.scoped(
    TestDb,
    testDatabase(label).pipe(
      Effect.mapError((cause) => new TestDbUnavailable({ cause })),
      Effect.timeoutFail({ duration: "20 seconds", onTimeout: () => new TestDbUnavailable({ cause: "timed out" }) }),
      Effect.map((url) => ({ url })),
    ),
  )
