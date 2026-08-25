import { Effect } from "effect"
import type { EntityRef, EntityVisibility, Ownership, PermissionActor, PermissionService } from "qwbe-core/permissions"
import {
  grantAccess,
  matchesVisibilityView,
  PermissionForbidden,
  PermissionNotFound,
  TotalActions,
} from "qwbe-core/permissions"
import type { PermissionState } from "./state.ts"
import { refKey, tables } from "./state.ts"

export const visibilityFrom = (state: PermissionState): Pick<PermissionService, "listVisible" | "setHidden"> => {
  const visibilityFor = (actor: PermissionActor, owner: Ownership) =>
    Effect.gen(function* () {
      const ref: EntityRef = { cube: owner.cube, entityType: owner.entityType, entityId: owner.entityId }
      const grants = yield* state.grantsFor(ref)
      const groupIds = yield* state.groupIdsFor(actor.userId)
      const granted = grantAccess(actor.userId, groupIds, grants)
      const admin = yield* state.cubeAdmin(actor, ref.cube)
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
      const hidden = (yield* state.store.all<{ id: string; userId: string; deleted?: boolean } & EntityRef>(
        tables.hidden,
      )).some((item) => !item.deleted && item.userId === actor.userId && refKey(item) === refKey(ref))
      return {
        ...ref,
        ownerId: owner.ownerId,
        createdBy: owner.createdBy,
        createdAt: owner.createdAt,
        access,
        hidden,
        sharedWithCount: grants.length,
      } satisfies EntityVisibility
    })
  return {
    listVisible: (actor, cube, view) =>
      Effect.gen(function* () {
        const owners = (yield* state.store.all<Ownership>(tables.ownership)).filter((row) => row.cube === cube)
        const visible = yield* Effect.forEach(owners, (owner) => visibilityFor(actor, owner))
        const result: Array<EntityVisibility> = []
        for (const row of visible) {
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
        const existing = (yield* state.store.all<{ id: string; userId: string; deleted?: boolean } & EntityRef>(
          tables.hidden,
        )).find((item) => !item.deleted && item.userId === actor.userId && refKey(item) === refKey(ref))
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
