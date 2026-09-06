import { Effect, Schema } from "effect"
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

export type StoredOwnership = Ownership & Readonly<{ id: string }>
export type StoredCubeAdmin = CubeAdmin & Readonly<{ deleted?: boolean }>
export type HiddenPreference = EntityRef & Readonly<{ id: string; userId: string; deleted?: boolean }>
export type StoredGrant = EntityGrant & Readonly<{ deleted?: boolean }>
export type StoredMembership = GroupMembership & Readonly<{ deleted?: boolean }>

export const refKey = (ref: EntityRef): string => [ref.cube, ref.entityType, ref.entityId].join(":")

/** Page size of `every`: the contract's MAX_LIMIT, so the read stays honest to the store. */
const PAGE = 200

export const stateFrom = (store: CubeTools["store"]) => {
  // Every matching row of a table, filtered by the STORE (`body ->> field = value` on
  // Postgres) rather than read whole and filtered here. Pages until `total` is reached, so
  // the result is complete whatever the page size. Fixtures may not honour `deleted`, so
  // callers keep their `deleted !== true` filter.
  const every = <A>(table: string, field: string, value: string) =>
    Effect.gen(function* () {
      const rows: Array<A> = []
      for (let offset = 0; ; offset += PAGE) {
        const page = yield* store.page<A>(table, { offset, limit: PAGE }, { field, value })
        rows.push(...page.rows)
        if (page.rows.length < PAGE || rows.length >= page.total) return rows
      }
    })
  const ownership = (ref: EntityRef) =>
    Effect.map(store.all<StoredOwnership>(tables.ownership), (rows) => rows.find((row) => refKey(row) === refKey(ref)))
  const cubeAdmin = (actor: PermissionActor, cube: string) =>
    Effect.map(
      store.all<StoredCubeAdmin>(tables.cubeAdmins),
      (rows) =>
        actor.roles.includes("admin") ||
        rows.some((row) => row.deleted !== true && row.cube === cube && row.userId === actor.userId),
    )
  const grantsFor = (ref: EntityRef) =>
    Effect.map(store.all<StoredGrant>(tables.grants), (rows) =>
      rows.filter((row) => row.deleted !== true && refKey(row) === refKey(ref)),
    )
  const groupIdsFor = (userId: string) =>
    Effect.map(
      every<StoredMembership>(tables.memberships, "userId", userId),
      (rows) => new Set(rows.filter((row) => row.deleted !== true).map((row) => row.groupId)),
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
      yield* store.insert(tables.audit, "AuditEvent", "audit", {
        traceId: ["trace", crypto.randomUUID()].join("-"),
        timestamp: new Date().toISOString(),
        actorUserId: actor.userId,
        ...ref,
        action,
        result,
        before: safeBefore,
        after: safeAfter,
      })
    }).pipe(Effect.asVoid)
  return { store, every, ownership, cubeAdmin, grantsFor, groupIdsFor, writeAudit }
}

export type PermissionState = ReturnType<typeof stateFrom>
