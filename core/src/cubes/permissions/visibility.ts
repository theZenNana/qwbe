import { Effect } from "effect"
import type {
  EntityRef,
  EntityVisibility,
  Ownership,
  PermissionActor,
  PermissionService,
  VisibilityView,
} from "qwbe-core/permissions"
import { TotalActions } from "qwbe-core/permissions"
import type { PermissionState } from "./state.ts"
import { refKey, tables } from "./state.ts"

const matchesView = (row: EntityVisibility, actor: PermissionActor, view: VisibilityView): boolean => {
  if (view === "all") return !row.hidden
  if (view === "owned-by-me") return row.ownerId === actor.userId && !row.hidden
  if (view === "created-by-me") return row.createdBy === actor.userId && !row.hidden
  if (view === "only-mine") return row.ownerId === actor.userId && row.sharedWithCount === 0 && !row.hidden
  if (view === "shared-by-me") return row.ownerId === actor.userId && row.sharedWithCount > 0 && !row.hidden
  if (view === "shared-with-me") return row.ownerId !== actor.userId && !row.hidden
  return row.hidden
}

export const visibilityFrom = (state: PermissionState): Pick<PermissionService, "listVisible" | "setHidden"> => {
  const visibilityFor = (actor: PermissionActor, owner: Ownership) =>
    Effect.gen(function* () {
      const ref: EntityRef = { cube: owner.cube, entityType: owner.entityType, entityId: owner.entityId }
      const grants = yield* state.grantsFor(ref)
      const groupIds = yield* state.groupIdsFor(actor.userId)
      const direct = grants.find((item) => item.subject.kind === "user" && item.subject.userId === actor.userId)
      const grouped = grants.find((item) => item.subject.kind === "group" && groupIds.has(item.subject.groupId))
      const groupedId = grouped?.subject.kind === "group" ? grouped.subject.groupId : ""
      const admin = yield* state.cubeAdmin(actor, ref.cube)
      const access =
        owner.ownerId === actor.userId
          ? { source: "owner" as const, name: actor.userId, actions: TotalActions }
          : direct
            ? { source: "user-grant" as const, name: actor.userId, actions: direct.actions }
            : grouped
              ? { source: "group-grant" as const, name: groupedId, actions: grouped.actions }
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
        for (const row of visible) if (row !== undefined && matchesView(row, actor, view)) result.push(row)
        return result
      }),
    setHidden: (actor, ref, hidden) =>
      Effect.gen(function* () {
        const owner = yield* state.ownership(ref)
        if (!owner) return yield* Effect.fail("entity has no ownership record")
        const visible = yield* visibilityFor(actor, owner)
        if (!visible) return yield* Effect.fail("entity is not visible to this user")
        const existing = (yield* state.store.all<{ id: string; userId: string; deleted?: boolean } & EntityRef>(
          tables.hidden,
        )).find((item) => !item.deleted && item.userId === actor.userId && refKey(item) === refKey(ref))
        if (hidden && !existing)
          yield* state.store.insert(tables.hidden, "HiddenPreference", "hidden", { ...ref, userId: actor.userId })
        if (!hidden && existing) yield* state.store.update(tables.hidden, existing.id, { deleted: true })
        const changed = yield* visibilityFor(actor, owner)
        if (!changed) return yield* Effect.fail("entity is not visible to this user")
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
