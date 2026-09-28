import { Effect } from "effect"
import type { PermissionState, StoredGrant, StoredOwnership } from "./state.ts"
import { entityKeyOf, tables } from "./state.ts"

/** One stored `entityKey` or `sharedWithCount` that disagrees with the live rows. */
export type CountMismatch = Readonly<{
  table: string
  id: string
  entityKey: string
  stored: number | undefined
  live: number
}>

// The Postgres `all` returns live rows only; the memory store keeps soft-deleted ones.
const live = <A extends { readonly deleted?: boolean }>(rows: ReadonlyArray<A>) =>
  rows.filter((row) => row.deleted !== true)

const liveRows = (state: PermissionState) =>
  Effect.all({
    grants: Effect.map(state.store.all<StoredGrant>(tables.grants), live),
    owners: Effect.map(state.store.all<StoredOwnership>(tables.ownership), live),
  })

/**
 * Fills `entityKey` on grants and `entityKey` plus `sharedWithCount` on ownership rows written
 * before those fields existed. A row that has them is skipped, so every boot may run it.
 * ponytail: reads both tables whole once per boot; a `not` filter on the missing field pages it.
 */
export const backfillCounts = (state: PermissionState) =>
  Effect.gen(function* () {
    const { grants, owners } = yield* liveRows(state)
    yield* Effect.forEach(
      grants.filter((grant) => grant.entityKey === undefined),
      (grant) => state.store.update(tables.grants, grant.id, { entityKey: entityKeyOf(grant) }),
    )
    yield* Effect.forEach(
      owners.filter((owner) => owner.entityKey === undefined || owner.sharedWithCount === undefined),
      (owner) => state.recountShares(owner),
    )
  })

/** Every ownership row whose key or count, and every grant whose key, disagrees with the live grants. */
export const reconcileCounts = (state: PermissionState) =>
  Effect.gen(function* () {
    const { grants, owners } = yield* liveRows(state)
    const counts = new Map<string, number>()
    for (const grant of grants) counts.set(entityKeyOf(grant), (counts.get(entityKeyOf(grant)) ?? 0) + 1)
    const mismatches: Array<CountMismatch> = []
    for (const owner of owners) {
      const entityKey = entityKeyOf(owner)
      const count = counts.get(entityKey) ?? 0
      if (owner.entityKey !== entityKey || owner.sharedWithCount !== count)
        mismatches.push({
          table: tables.ownership,
          id: owner.id,
          entityKey,
          stored: owner.sharedWithCount,
          live: count,
        })
    }
    for (const grant of grants) {
      const entityKey = entityKeyOf(grant)
      if (grant.entityKey !== entityKey)
        mismatches.push({
          table: tables.grants,
          id: grant.id,
          entityKey,
          stored: undefined,
          live: counts.get(entityKey) ?? 0,
        })
    }
    return mismatches
  })
