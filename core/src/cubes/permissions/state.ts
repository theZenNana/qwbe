import { DateTime, Effect, Option, Schema } from "effect"
import type { CubeTools } from "qwbe-core/cube"
import type {
  AuditEvent,
  AuditValue,
  CubeAdmin,
  EntityGrant,
  EntityRef,
  GroupMembership,
  Ownership,
  PermissionActor,
} from "qwbe-core/permissions"
import { AuditValueSchema, PermissionInvalid } from "qwbe-core/permissions"

export const tables = {
  ownership: "permission_ownership",
  cubeAdmins: "permission_cube_admins",
  audit: "permission_audit",
  groups: "permission_groups",
  memberships: "permission_memberships",
  grants: "permission_grants",
  hidden: "permission_hidden",
  capabilities: "permission_capability_grants",
} as const

// `entityKey` and `sharedWithCount` are optional: rows written before they existed lack them
// until `backfillCounts` (counts.ts) runs at boot.
export type StoredOwnership = Ownership &
  Readonly<{ id: string; entityKey?: string; sharedWithCount?: number; deleted?: boolean }>
export type StoredCubeAdmin = CubeAdmin & Readonly<{ deleted?: boolean }>
export type HiddenPreference = EntityRef & Readonly<{ id: string; userId: string; deleted?: boolean }>
export type StoredGrant = EntityGrant & Readonly<{ entityKey?: string; deleted?: boolean }>
export type StoredMembership = GroupMembership & Readonly<{ deleted?: boolean }>

/** An entity ref (cube + entityType + entityId) as a store `where`. */
export const refWhere = (ref: EntityRef) => [
  { field: "cube", value: ref.cube },
  { field: "entityType", value: ref.entityType },
  { field: "entityId", value: ref.entityId },
]

/** One indexed key per entity, `cube:entityType:entityId`, stored on ownership and grant rows. */
export const entityKeyOf = (ref: EntityRef) => [ref.cube, ref.entityType, ref.entityId].join(":")

export const stateFrom = (store: CubeTools["store"]) => {
  // Every live row of a table with `field = value`, filtered by the STORE (`body ->> field` on
  // Postgres) in one read, no paging and no COUNT.
  const every = <A>(table: string, field: string, value: string) => store.where<A>(table, { field, value })
  const ownership = (ref: EntityRef) =>
    Effect.map(store.first<StoredOwnership>(tables.ownership, refWhere(ref)), Option.getOrUndefined)
  const cubeAdmin = (actor: PermissionActor, cube: string) =>
    actor.roles.includes("admin")
      ? Effect.succeed(true)
      : Effect.map(
          store.first<StoredCubeAdmin>(tables.cubeAdmins, [
            { field: "cube", value: cube },
            { field: "userId", value: actor.userId },
          ]),
          Option.isSome,
        )
  const grantsFor = (ref: EntityRef) => store.where<StoredGrant>(tables.grants, refWhere(ref))
  // Recount and set, never increment: `update` is an unlocked read-modify-write, so a lost
  // increment would stay wrong, while a recount heals on the next grant change.
  const recountShares = (ref: EntityRef) =>
    Effect.gen(function* () {
      const sharedWithCount = (yield* grantsFor(ref)).length
      const owners = yield* store.where<StoredOwnership>(tables.ownership, refWhere(ref))
      yield* Effect.forEach(owners, (row) =>
        store.update(tables.ownership, row.id, { entityKey: entityKeyOf(ref), sharedWithCount }),
      )
    })
  const groupIdsFor = (userId: string) =>
    Effect.map(
      every<StoredMembership>(tables.memberships, "userId", userId),
      (rows) => new Set(rows.map((row) => row.groupId)),
    )
  const writeAudit = (
    actor: PermissionActor,
    ref: EntityRef,
    action: string,
    result: AuditEvent["result"],
    before: unknown,
    after: unknown,
  ) =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknown(AuditValueSchema)
      const safeBefore: AuditValue = yield* decode(before).pipe(
        Effect.mapError(() => new PermissionInvalid({ message: "audit before trace must be JSON data" })),
      )
      const safeAfter: AuditValue = yield* decode(after).pipe(
        Effect.mapError(() => new PermissionInvalid({ message: "audit after trace must be JSON data" })),
      )
      const traceId = yield* Effect.sync(() => ["trace", crypto.randomUUID()].join("-"))
      yield* store.insert(tables.audit, "AuditEvent", "audit", {
        traceId,
        timestamp: DateTime.formatIso(yield* DateTime.now),
        actorUserId: actor.userId,
        ...ref,
        action,
        result,
        before: safeBefore,
        after: safeAfter,
      })
    }).pipe(Effect.asVoid)
  return { store, every, ownership, cubeAdmin, grantsFor, recountShares, groupIdsFor, writeAudit }
}

export type PermissionState = ReturnType<typeof stateFrom>
