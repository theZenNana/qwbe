import { Effect } from "effect"
import type { GroupMembership, PermissionGroup, PermissionService } from "qwbe-core/permissions"
import type { PermissionState, StoredMembership } from "./state.ts"
import { tables } from "./state.ts"

export const groupById = (state: PermissionState, groupId: string) =>
  Effect.map(state.store.all<PermissionGroup>(tables.groups), (groups) => groups.find((group) => group.id === groupId))

export const groupsFrom = (
  state: PermissionState,
): Pick<PermissionService, "createGroup" | "renameGroup" | "groups" | "addGroupMember" | "removeGroupMember"> => {
  const requireAdmin = (actor: Parameters<PermissionService["createGroup"]>[0], group: PermissionGroup) =>
    Effect.gen(function* () {
      if (
        actor.roles.includes("admin") ||
        group.createdBy === actor.userId ||
        (yield* state.cubeAdmin(actor, group.cube))
      )
        return
      return yield* Effect.fail("only group creator or cube admin may administer this group")
    })
  return {
    createGroup: (actor, cube, name) =>
      Effect.gen(function* () {
        if (!actor.roles.includes("admin") && !(yield* state.cubeAdmin(actor, cube))) {
          const ownsInCube = (yield* state.store.all<{ cube: string; ownerId: string }>(tables.ownership)).some(
            (ownership) => ownership.cube === cube && ownership.ownerId === actor.userId,
          )
          if (!ownsInCube) return yield* Effect.fail("only an entity owner or cube admin may create groups")
        }
        const createdAt = new Date().toISOString()
        const row = yield* state.store.insert(tables.groups, "PermissionGroup", "grp", {
          cube,
          name,
          createdBy: actor.userId,
          createdAt,
        })
        const value: PermissionGroup = { id: String(row.id), cube, name, createdBy: actor.userId, createdAt }
        yield* state.writeAudit(
          actor,
          { cube, entityType: "Group", entityId: value.id },
          "group.create",
          "success",
          null,
          value,
        )
        return value
      }),
    renameGroup: (actor, groupId, name) =>
      Effect.gen(function* () {
        const group = yield* groupById(state, groupId)
        if (!group) return yield* Effect.fail(["group", groupId, "does not exist"].join(" "))
        yield* requireAdmin(actor, group)
        yield* state.store.update(tables.groups, groupId, { name })
        const changed = { ...group, name }
        yield* state.writeAudit(
          actor,
          { cube: group.cube, entityType: "Group", entityId: groupId },
          "group.rename",
          "success",
          group,
          changed,
        )
        return changed
      }),
    groups: (actor, cube) =>
      Effect.gen(function* () {
        if (!actor.roles.includes("admin") && !(yield* state.cubeAdmin(actor, cube))) {
          const ownsInCube = (yield* state.store.all<{ cube: string; ownerId: string }>(tables.ownership)).some(
            (ownership) => ownership.cube === cube && ownership.ownerId === actor.userId,
          )
          if (!ownsInCube) return yield* Effect.fail("only an entity owner or cube admin may list groups")
        }
        return (yield* state.store.all<PermissionGroup>(tables.groups)).filter((group) => group.cube === cube)
      }),
    addGroupMember: (actor, groupId, userId) =>
      Effect.gen(function* () {
        const group = yield* groupById(state, groupId)
        if (!group) return yield* Effect.fail(["group", groupId, "does not exist"].join(" "))
        yield* requireAdmin(actor, group)
        const existing = (yield* state.store.all<StoredMembership>(tables.memberships)).find(
          (item) => item.deleted !== true && item.groupId === groupId && item.userId === userId,
        )
        if (existing) return existing
        const createdAt = new Date().toISOString()
        const row = yield* state.store.insert(tables.memberships, "GroupMembership", "mem", {
          groupId,
          userId,
          createdBy: actor.userId,
          createdAt,
        })
        const value: GroupMembership = { id: String(row.id), groupId, userId, createdBy: actor.userId, createdAt }
        yield* state.writeAudit(
          actor,
          { cube: group.cube, entityType: "Group", entityId: groupId },
          "group.member.add",
          "success",
          null,
          value,
        )
        return value
      }),
    removeGroupMember: (actor, groupId, userId) =>
      Effect.gen(function* () {
        const group = yield* groupById(state, groupId)
        if (!group) return yield* Effect.fail(["group", groupId, "does not exist"].join(" "))
        yield* requireAdmin(actor, group)
        const membership = (yield* state.store.all<StoredMembership>(tables.memberships)).find(
          (item) => item.deleted !== true && item.groupId === groupId && item.userId === userId,
        )
        if (!membership) return yield* Effect.fail("membership does not exist")
        yield* state.store.update(tables.memberships, membership.id, { deleted: true })
        yield* state.writeAudit(
          actor,
          { cube: group.cube, entityType: "Group", entityId: groupId },
          "group.member.remove",
          "success",
          membership,
          null,
        )
      }),
  }
}
