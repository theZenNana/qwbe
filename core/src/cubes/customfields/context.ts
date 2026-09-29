// Shared context for the customfields handlers. The in-memory snapshot exists because the kernel's provider registry is a
// synchronous read while definitions live in the store; it is refreshed on load and on every
// write, so the catalogue's custom metadata and the orphan report see current definitions.

import { Effect } from "effect"
import type { CubeTools } from "qwbe-core/cube"
import { byPosition, DEFS, type DefRow } from "./schema.ts"

export type PackTools = Pick<CubeTools, "store" | "bus" | "catalogue"> & {
  customFields: NonNullable<CubeTools["customFields"]>
}

type Store = CubeTools["store"]

/** The live in-memory snapshot the kernel's provider reads; refreshed on load and on every write.
 *
 * this snapshot feeds ONLY the catalogue's metadata provider --
 * a synchronous read that cannot reach the store. VALUE VALIDATION no longer rides on it: the
 * fold reads the definitions from the store per request through the registered defs reader, so
 * a second API instance on the same database sees new definitions immediately, and a failed
 * read fails its request instead of silently validating on empty. A failed refresh here leaves
 * the previous snapshot in place, which is a metadata publication delay, never a skipped
 * validation.
 */
export type Snapshot = {
  current: ReadonlyArray<DefRow>
  /** Tickets handed to reads as they start. */
  reads: number
  /** Per target cube, the ticket of the read that last replaced its rows; "*" is a full read. */
  applied: Map<string, number>
}

export const emptySnapshot = (): Snapshot => ({ current: [], reads: 0, applied: new Map() })

export const definitionsFor = (store: Store, cube: string) =>
  Effect.gen(function* () {
    const rows = yield* store.where<DefRow>(DEFS, { field: "targetCube", value: cube })
    return [...rows].sort(byPosition)
  })

/** Reload one target cube's definitions, or with no cube all of them (once, at boot).
 *
 * Concurrent writes can have their reads resolve out of order, so each read takes a ticket when
 * it starts and replaces a cube's rows only if no read that started later already did. A write
 * starts its read after its own commit, so the latest-started read of a cube sees every write
 * committed to it before, and a late, older read can never drop a newer definition.
 */
export const refreshSnapshot = (store: Store, snapshot: Snapshot, cube?: string) =>
  Effect.gen(function* () {
    const ticket = ++snapshot.reads
    const rows =
      cube === undefined
        ? yield* store.all<DefRow>(DEFS)
        : yield* store.where<DefRow>(DEFS, { field: "targetCube", value: cube })
    const last = (c: string) => Math.max(snapshot.applied.get(c) ?? 0, snapshot.applied.get("*") ?? 0)
    const replaced = (c: string) => (cube === undefined || c === cube) && last(c) < ticket
    snapshot.current = [
      ...snapshot.current.filter((d) => !replaced(d.targetCube)),
      ...rows.filter((d) => d.deleted === false && replaced(d.targetCube)),
    ]
    const key = cube ?? "*"
    snapshot.applied.set(key, Math.max(ticket, snapshot.applied.get(key) ?? 0))
  }).pipe(Effect.catchAllCause(() => Effect.void))
