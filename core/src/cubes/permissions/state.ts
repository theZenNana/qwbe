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
} as const

export type StoredOwnership = Ownership & Readonly<{ id: string }>
export type StoredCubeAdmin = CubeAdmin & Readonly<{ deleted?: boolean }>
export type HiddenPreference = EntityRef & Readonly<{ id: string; userId: string; deleted?: boolean }>
export type StoredGrant = EntityGrant & Readonly<{ deleted?: boolean }>
export type StoredMembership = GroupMembership & Readonly<{ deleted?: boolean }>

export const refKey = (ref: EntityRef): string => [ref.cube, ref.entityType, ref.entityId].join(":")

export const stateFrom = (store: CubeTools["store"]) => {
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
      store.all<StoredMembership>(tables.memberships),
      (rows) => new Set(rows.filter((row) => row.deleted !== true && row.userId === userId).map((row) => row.groupId)),
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
  return { store, ownership, cubeAdmin, grantsFor, groupIdsFor, writeAudit }
}

export type PermissionState = ReturnType<typeof stateFrom>
