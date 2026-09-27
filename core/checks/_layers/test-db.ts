import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { testDatabase } from "../../src/pg/test-db.ts"

/** A throwaway Postgres database for one test file. */
export class TestDb extends Context.Tag("TestDb")<TestDb, { readonly url: string }>() {}

/** Creates `qwbe_test_<label>_<random>` and drops it WITH (FORCE) when the scope closes. */
export const testDb = (label: string) =>
  Layer.scoped(
    TestDb,
    Effect.map(testDatabase(label), (url) => ({ url })),
  )
