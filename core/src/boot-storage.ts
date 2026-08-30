// The storage half of the boot: init the Postgres store, then run the declared data
// migrations. Split out of main.ts (QWB-44) when the Postgres move pushed main.ts past its
// file cap -- the boot order itself is unchanged and lives in exactly one place.
//
// Both steps stop the boot with the variable or reason named: a missing or unreachable
// database has no fallback, and a refused migration means the operator chooses, not the
// kernel. The `fail` and `failAfterSnapshot` continuations are injected so the ledger
// restore-on-failure behaviour stays in main.ts, next to the snapshot it protects.

import type { CubeDefinition } from "./cube-contract.ts"
import type { Ledger } from "./kernel/ledger.ts"
import { migrateDataSchemas } from "./kernel/migrate.ts"
import { checkMigrationOwnership } from "./kernel/migrate-ownership.ts"
import { initStore } from "./kernel/store.ts"

export const bootStorage = async (
  definitions: ReadonlyArray<{ name: string; plugin: string | null; definition: CubeDefinition }>,
  ledgerSnapshot: Ledger,
  fail: (e: Error, code: number) => never,
  failAfterSnapshot: (e: Error, code: number) => never,
): Promise<void> => {
  await initStore().catch((e: Error) => fail(e, 2))
  await migrateDataSchemas(await checkMigrationOwnership(definitions, ledgerSnapshot)).catch((e: Error) =>
    failAfterSnapshot(e, 2),
  )
}
