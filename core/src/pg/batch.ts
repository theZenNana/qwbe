// The batch capability: raw SQL batches, one transaction, the cube's own role.
//
// Three things the six-operation CubeStore cannot
// express without loading whole tables into JavaScript:
//
//   - a multi-row insert that is ONE transaction (100k rows as 100k single-row transactions
//     would be minutes, not seconds);
//   - a delete that clears two tables atomically;
//   - aggregation over jsonb IN SQL, one pass per field.
//
// Isolation is NOT weakened: the batch runs under the cube's own role (`withRole`), so a
// statement aimed at another cube's schema still dies in Postgres with a permission error --
// the engine enforces the boundary, exactly as for every other operation. Table names inside
// the statements are the CALLER's own constants; field names and ids travel as bound
// parameters, never concatenated into the SQL text.

import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import type { CubeStore } from "../kernel/store-contract.ts"
import { run } from "./db.ts"
import { q, schemaName, withRole } from "./setup.ts"

/** One SQL statement inside a batch: text plus bound values. Identifiers are never parameters
 *  and never arrive here -- the caller quotes them itself (see `q`), values are always bound. */
export type SqlStatement = {
  readonly text: string
  readonly values?: ReadonlyArray<unknown>
}

/** The six CubeStore operations, plus the batch. A `BatchStore` is assignable to `CubeStore`. */
export type BatchStore = CubeStore & {
  readonly batch: (
    statements: ReadonlyArray<SqlStatement>,
  ) => Effect.Effect<ReadonlyArray<ReadonlyArray<Record<string, unknown>>>, never, never>
}

/** The batch method itself, bound to one cube. Returns ONE ROW ARRAY PER STATEMENT, in order. */
export const batchFor =
  (cube: string): BatchStore["batch"] =>
  (statements) =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* withRole(
          cube,
          Effect.gen(function* () {
            // The cube's statements use its OWN table names unqualified -- the schema is the
            // cube's context, like the SQLite file was. search_path is set per transaction, so
            // an unqualified name can only ever resolve inside the cube's own schema. The schema
            // name is QUOTED: child cube names contain `--`, and the GUC value is a raw string,
            // not an identifier.
            yield* sql`SELECT set_config('search_path', ${q(schemaName(cube))}, true)`
            return yield* Effect.forEach(statements, (s) =>
              sql.unsafe<Record<string, unknown>>(s.text, [...(s.values ?? [])]),
            )
          }),
        )
      }),
    )
