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
import { checkMigrationOwnership, type ValidatedMigration } from "./kernel/migrate-ownership.ts"
import { initStore } from "./kernel/store.ts"

export const bootStorage = async (
  definitions: ReadonlyArray<{ name: string; plugin: string | null; definition: CubeDefinition }>,
  ledgerSnapshot: Ledger,
  fail: (e: Error, code: number) => never,
  failAfterSnapshot: (e: Error, code: number) => never,
): Promise<ReadonlyArray<ValidatedMigration>> => {
  await initStore().catch((e: Error) => fail(e, 2))
  // The awaits are sequenced INSIDE the try: writing `await f(await g()).catch(h)` evaluates
  // g() before the call expression, so a MigrationOwnershipError escapes as a top-level
  // rejection (exit 1 with a stack) and the ledger restore never runs. This shape is what
  // the old synchronous mount() path guaranteed.
  try {
    const ms = await checkMigrationOwnership(definitions, ledgerSnapshot)
    await migrateDataSchemas(ms)
    // The validated migrations travel back to main.ts: it records each source in the ledger
    // (QWB-54 ticket 08), so a completed migration stays attributable after its source schema
    // is gone -- the restart of a migrated system must not need the operator's env forever.
    return ms
  } catch (e) {
    failAfterSnapshot(e as Error, 2)
  }
}
