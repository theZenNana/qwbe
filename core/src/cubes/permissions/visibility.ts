import { Effect, Option } from "effect"
import type { EntityRef, EntityVisibility, Ownership, PermissionActor, PermissionService } from "qwbe-core/permissions"
import {
  grantAccess,
  matchesVisibilityView,
  PermissionForbidden,
  PermissionNotFound,
  TotalActions,
} from "qwbe-core/permissions"
import type { HiddenPreference, PermissionState, StoredGrant } from "./state.ts"
import { refWhere, tables } from "./state.ts"

const hiddenWhere = (userId: string, ref: EntityRef) => [{ field: "userId", value: userId }, ...refWhere(ref)]

const entityKey = (ref: Pick<EntityRef, "entityType" | "entityId">) => JSON.stringify([ref.entityType, ref.entityId])

/** The visibility rules over preloaded data: `undefined` when the actor may not see the entity. */
const decide = (
  actor: PermissionActor,
  owner: Ownership,
  grants: ReadonlyArray<StoredGrant>,
  groupIds: ReadonlySet<string>,
  admin: boolean,
  hidden: boolean,
): EntityVisibility | undefined => {
  const granted = grantAccess(actor.userId, groupIds, grants)
  const access =
    owner.ownerId === actor.userId
      ? { source: "owner" as const, name: actor.userId, actions: TotalActions }
      : granted
        ? granted
        : owner.createdBy === actor.userId && admin
          ? { source: "creator" as const, name: actor.userId, actions: TotalActions }
          : actor.roles.includes("admin")
            ? { source: "superadmin" as const, name: actor.userId, actions: TotalActions }
            : admin
              ? { source: "cube-admin" as const, name: actor.userId, actions: TotalActions }
              : undefined
  if (!access) return undefined
  return {
    cube: owner.cube,
    entityType: owner.entityType,
    entityId: owner.entityId,
    ownerId: owner.ownerId,
    createdBy: owner.createdBy,
    createdAt: owner.createdAt,
    access,
    hidden,
    sharedWithCount: grants.length,
  }
}

export const visibilityFrom = (state: PermissionState): Pick<PermissionService, "listVisible" | "setHidden"> => {
  const visibilityFor = (actor: PermissionActor, owner: Ownership) =>
    Effect.gen(function* () {
      const ref: EntityRef = { cube: owner.cube, entityType: owner.entityType, entityId: owner.entityId }
      const grants = yield* state.grantsFor(ref)
      const groupIds = yield* state.groupIdsFor(actor.userId)
      const admin = yield* state.cubeAdmin(actor, ref.cube)
      const hidden = Option.isSome(yield* state.store.first(tables.hidden, hiddenWhere(actor.userId, ref)))
      return decide(actor, owner, grants, groupIds, admin, hidden)
    })
  return {
    // One read per table for the whole cube (ownership, grants, hidden, memberships, cube admin),
    // then `decide` per row in memory.
    listVisible: (actor, cube, view) =>
      Effect.gen(function* () {
        const byCube = { field: "cube", value: cube }
        const owners = yield* state.store.where<Ownership>(tables.ownership, byCube)
        const grants = new Map<string, Array<StoredGrant>>()
        for (const grant of yield* state.store.where<StoredGrant>(tables.grants, byCube)) {
          const key = entityKey(grant)
          const list = grants.get(key)
          if (list) list.push(grant)
          else grants.set(key, [grant])
        }
        const hidden = new Set(
          (yield* state.store.where<HiddenPreference>(tables.hidden, [
            { field: "userId", value: actor.userId },
            byCube,
          ])).map(entityKey),
        )
        const groupIds = yield* state.groupIdsFor(actor.userId)
        const admin = yield* state.cubeAdmin(actor, cube)
        const result: Array<EntityVisibility> = []
        for (const owner of owners) {
          const key = entityKey(owner)
          const row = decide(actor, owner, grants.get(key) ?? [], groupIds, admin, hidden.has(key))
          if (row !== undefined && matchesVisibilityView(row, actor.userId, view)) result.push(row)
        }
        return result
      }),
    setHidden: (actor, ref, hidden) =>
      Effect.gen(function* () {
        const owner = yield* state.ownership(ref)
        if (!owner) {
          return yield* Effect.fail(new PermissionNotFound({ message: "entity has no ownership record" }))
        }
        const visible = yield* visibilityFor(actor, owner)
        if (!visible) {
          return yield* Effect.fail(new PermissionForbidden({ message: "entity is not visible to this user" }))
        }
        const existing = Option.getOrUndefined(
          yield* state.store.first<HiddenPreference>(tables.hidden, hiddenWhere(actor.userId, ref)),
        )
        if (hidden && !existing)
          yield* state.store.insert(tables.hidden, "HiddenPreference", "hidden", { ...ref, userId: actor.userId })
        if (!hidden && existing) yield* state.store.update(tables.hidden, existing.id, { deleted: true })
        const changed = yield* visibilityFor(actor, owner)
        if (!changed) {
          return yield* Effect.fail(new PermissionForbidden({ message: "entity is not visible to this user" }))
        }
        yield* state.writeAudit(
          actor,
          ref,
          hidden ? "visibility.hide" : "visibility.unhide",
          "success",
          { hidden: visible.hidden },
          { hidden: changed.hidden },
        )
        return changed
      }),
  }
}
