// The storage half of the boot: the Postgres store as a layer, then the declared data
// migrations. The boot order itself is unchanged and lives in exactly one place, main.ts.
//
// Both steps stop the boot with the variable or reason named: a missing or unreachable
// database has no fallback, and a refused migration means the operator chooses, not the
// kernel. Each failure is typed; main.ts maps it to the exit code at its edge and restores the
// ledger snapshot it protects.

import { Data, Effect, Layer } from "effect"
import { QwbeConfig } from "./config.ts"
import type { CubeDefinition } from "./cube-contract.ts"
import { refusal } from "./kernel/discovery.ts"
import type { Ledger } from "./kernel/ledger.ts"
import { migrateDataSchemas } from "./kernel/migrate.ts"
import { checkMigrationOwnership, type ValidatedMigration } from "./kernel/migrate-ownership.ts"
import { initStore } from "./kernel/store.ts"

/** A boot step refused to go on: discovery, storage, a migration or the mount. Exit code 2. */
export class BootRefused extends Data.TaggedError("BootRefused")<{ readonly message: string }> {}

/** A life rule failed after the mount: a dead cube, an open endpoint, a schema drift. Exit code 1. */
export class LifeRuleBroken extends Data.TaggedError("LifeRuleBroken")<{ readonly message: string }> {}

/** Connect, make sure the kernel schema exists, apply the kernel's own SQL migrations. */
export const StorageLive = Layer.effectDiscard(
  Effect.tryPromise({ try: initStore, catch: (e) => new BootRefused({ message: (e as Error).message }) }),
)

/**
 * The declared data migrations, checked against the trusted ledger snapshot. The validated
 * migrations travel back to main.ts: it records each source in the ledger, so a completed
 * migration stays attributable after its source schema is gone -- the restart of a migrated
 * system must not need the operator's env forever.
 */
export const bootStorage = (
  definitions: ReadonlyArray<{ name: string; plugin: string | null; definition: CubeDefinition }>,
  ledgerSnapshot: Ledger,
): Effect.Effect<ReadonlyArray<ValidatedMigration>, Error, QwbeConfig> =>
  Effect.gen(function* () {
    const { legacyMigrations } = yield* QwbeConfig
    const ms = yield* refusal(() => checkMigrationOwnership(definitions, ledgerSnapshot, legacyMigrations))
    yield* migrateDataSchemas(ms)
    return ms
  })
