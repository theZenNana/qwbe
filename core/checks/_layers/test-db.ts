import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { createTestDatabase } from "../../src/pg/test-db.ts"

/** A throwaway Postgres database for one test file. */
export class TestDb extends Context.Tag("TestDb")<TestDb, { readonly url: string }>() {}

/** Creates `qwbe_test_<label>_<random>` and drops it WITH (FORCE) when the scope closes. */
export const testDb = (label: string) =>
  Layer.scoped(
    TestDb,
    Effect.acquireRelease(
      // Bounded: a Postgres out of connections must fail this layer before vitest kills the worker,
      // or the finalizers that stop servers and drop databases never run.
      Effect.promise(() => createTestDatabase(label)).pipe(
        Effect.timeoutFail({
          duration: "20 seconds",
          onTimeout: () => new Error(`creating the test database "${label}" took over 20 s`),
        }),
        Effect.orDie,
      ),
      (db) => Effect.promise(() => db.drop()),
    ).pipe(Effect.map((db) => ({ url: db.url }))),
  )
