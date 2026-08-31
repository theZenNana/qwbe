// The store, over one Postgres database with a schema per cube (ADR-0001, QWB-44).
//
// What was here before was one SQLite file PER CUBE, and the file boundary made the isolation
// physical rather than polite: another cube's data was not in a table this connection could
// see, it was in another FILE. The move to Postgres spends that boundary and rebuilds it in
// the engine instead: one NOLOGIN role per cube (`pg/setup.ts`), every operation inside a
// transaction that starts with `SET LOCAL ROLE` (`pg/store.ts`), and a probe
// (`probes/store-isolation.mjs`) that proves a cube's role cannot read another cube's schema.
// What Postgres buys for the price: real transactions, numbered schema migrations applied at
// boot, jsonb with a GIN index, a connection pool, and an outbox row written in the same
// transaction as every row change.
//
// This file keeps the SAME exports the kernel and the tests have always used -- `storeFor`,
// `closeAll`, `ForeignTableError`, `checkUniqueTables`, `DuplicateTableError` -- so the mount
// code and every cube stay untouched. The implementation lives in `pg/`.

import { Effect } from "effect"
import type { CustomFieldTools } from "../catalogue.ts"
import { registerCustomFieldProvider } from "../catalogue.ts"
import type { CustomRowView } from "../custom-defs-reader.ts"
import { registerCustomFieldDefsReader } from "../custom-defs-reader.ts"
import { customRowById, customRows } from "../pg/custom-rows.ts"

export { closeAll, databaseUrl, initStore } from "../pg/db.ts"
export { ForeignTableError } from "../pg/errors.ts"
export { storeFor } from "../pg/store.ts"

/**
 * Two cubes cannot own the same table.
 *
 * Without this check, `notes` could declare `tables: ["accounts"]` and walk around the whole
 * mechanism -- legally, with a valid manifest. That is exactly the shape of failure worth
 * guarding against: the loophole is legal, so nobody reads it as a problem.
 *
 * Under one schema per cube the collision is more than a naming one: two cubes granted roles
 * over the same table would both hold the data. A shared name is how the confusion starts, so
 * it is refused anyway.
 */
export class DuplicateTableError extends Error {
  constructor(table: string, cubes: ReadonlyArray<string>) {
    super(
      `Table "${table}" is declared by more than one cube: ${cubes.join(", ")}. ` +
        `A table has exactly one owner. Whoever needs the data asks through the registry.`,
    )
    this.name = "DuplicateTableError"
  }
}

export const checkUniqueTables = (
  cubes: ReadonlyArray<{ readonly name: string; readonly tables: ReadonlyArray<string> }>,
): void => {
  const owners = new Map<string, Array<string>>()
  for (const c of cubes) {
    for (const t of c.tables) {
      const list = owners.get(t) ?? []
      list.push(c.name)
      owners.set(t, list)
    }
  }
  for (const [table, list] of owners) {
    if (list.length > 1) throw new DuplicateTableError(table, list)
  }
}

// --- QWB-46: the tool for the one cube declaring `providesCustomFields` ---
//
// `register` feeds the catalogue's provider registry (catalogue.ts); `rows` reads a target
// cube's rows through the target's OWN store -- its schema, its role, the same trusted
// construction the mount itself uses -- so orphan reporting never needs a sidecar copy of the
// values. The finder is passed in lazily: at mount, the mounted-cubes list does not exist yet.
export const customFieldToolsFor = (
  find: (name: string) =>
    | {
        readonly manifest: { readonly tables?: readonly string[]; readonly sortable?: readonly string[] }
      }
    | undefined,
): CustomFieldTools => ({
  register: (provide) => registerCustomFieldProvider((cube) => (find(cube) ? provide(cube) : [])),
  // The reader is guarded by the same mounted-cube check as the metadata provider: a
  // definition can only target a mounted cube, and anything else reads as no definitions.
  registerDefsReader: (read) => registerCustomFieldDefsReader((cube) => (find(cube) ? read(cube) : Effect.succeed([]))),
  rows: (cube) =>
    Effect.gen(function* () {
      const target = find(cube)
      if (!target) return []
      return yield* customRows(cube, target.manifest.tables ?? [])
    }),
  row: (cube, rowId): Effect.Effect<CustomRowView | undefined, never, never> =>
    Effect.gen(function* () {
      const target = find(cube)
      if (!target) return undefined
      return yield* customRowById(cube, target.manifest.tables ?? [], rowId)
    }),
})
