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

export { closeAll, databaseUrl, initStore } from "./pg/db.ts"
export { ForeignTableError } from "./pg/errors.ts"
export { storeFor } from "./pg/store.ts"

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
