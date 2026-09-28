// The one capability staging needs beyond the six CubeStore operations: SQL batches.
//
// WHY the cube needs it: profiling must be computed IN SQL over the jsonb body (one pass per
// field, never the whole set in JavaScript), a 100k-row import must land as a handful of
// batched transactions instead of one transaction per row, and a delete must clear two tables
// in ONE transaction. The six-operation CubeStore cannot express any of the three.
//
// HOW it stays safe: the batch is a DECLARED capability (`usesBatch: true` in the manifest):
// only cubes that ask get a store with `batch` on it, and
// `grep -r usesBatch` returns the complete list of holders. Each batch runs inside one
// transaction under the cube's OWN role -- a statement aimed at another cube's schema dies in
// Postgres with a permission error, the same engine-enforced boundary every other operation
// sits behind. Staging composes SQL only for the two tables its manifest declares; field names
// travel as bound parameters (`body->'record'->>$1`), never as concatenated SQL.
//
// The type is declared HERE, structurally, and checked at runtime -- the same pattern the
// settings cube uses for the installer's scan capability. The cube imports nothing from the
// pg subsystem; the shape is the contract.

import type { Effect } from "effect"
import type { CubeTools } from "qwbe-core/cube"
import { requireTool } from "../shared.ts"

export type SqlStatement = {
  readonly text: string
  readonly values?: ReadonlyArray<unknown>
  /** The rows this statement wrote whose sortable fields may have changed; the store re-keys them. */
  readonly rekey?: { readonly table: string; readonly ids: ReadonlyArray<string> }
}

export type BatchStore = {
  readonly batch: (
    statements: ReadonlyArray<SqlStatement>,
  ) => Effect.Effect<ReadonlyArray<ReadonlyArray<Record<string, unknown>>>, never, never>
}

/**
 * Narrow the kernel-provided store to the batch capability, with a runtime shape check -- never
 * a blind cast. The kernel builds the store from `storeFor` with the batch ONLY when the
 * manifest declares `usesBatch`; the check keeps the cube honest if that ever stops being true.
 */
export const asBatchStore = (store: CubeTools["store"]): BatchStore =>
  requireTool(
    "batch" in store ? (store as unknown as BatchStore) : undefined,
    "staging requires a store with the batch capability (the Postgres store)",
  )
