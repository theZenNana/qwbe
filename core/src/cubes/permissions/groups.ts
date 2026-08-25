import { Effect } from "effect"
import type { GroupMembership, PermissionGroup, PermissionService } from "qwbe-core/permissions"
import { PermissionForbidden, PermissionInvalid, PermissionNotFound } from "qwbe-core/permissions"
import type { PermissionState, StoredMembership } from "./state.ts"
import { tables } from "./state.ts"

export const groupById = (state: PermissionState, groupId: string) =>
  Effect.map(state.store.all<PermissionGroup>(tables.groups), (groups) => groups.find((group) => group.id === groupId))

export const groupsFrom = (
  state: PermissionState,
): Pick<PermissionService, "createGroup" | "renameGroup" | "groups" | "addGroupMember" | "removeGroupMember"> => {
  const requireCubeAccess = (actor: Parameters<PermissionService["createGroup"]>[0], cube: string) =>
    Effect.gen(function* () {
      if (actor.roles.includes("admin") || (yield* state.cubeAdmin(actor, cube))) return
      const owns = (yield* state.store.all<{ cube: string; ownerId: string }>(tables.ownership)).some(
        (row) => row.cube === cube && row.ownerId === actor.userId,
      )
      if (!owns) {
        return yield* Effect.fail(
          new PermissionForbidden({ message: "only an entity owner or cube admin may manage groups" }),
        )
      }
    })
  const administer = (actor: Parameters<PermissionService["createGroup"]>[0], groupId: string) =>
    Effect.gen(function* () {
      const group = yield* groupById(state, groupId)
      if (!group) {
        return yield* Effect.fail(new PermissionNotFound({ message: ["group", groupId, "does not exist"].join(" ") }))
      }
      yield* requireCubeAccess(actor, group.cube)
      return group
    })
  return {
    createGroup: (actor, cube, name) =>
      Effect.gen(function* () {
        if (name.trim().length === 0) {
          return yield* Effect.fail(new PermissionInvalid({ message: "group name must not be empty" }))
        }
        yield* requireCubeAccess(actor, cube)
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
        const group = yield* administer(actor, groupId)
        if (name.trim().length === 0) {
          return yield* Effect.fail(new PermissionInvalid({ message: "group name must not be empty" }))
        }
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
        yield* requireCubeAccess(actor, cube)
        return (yield* state.store.all<PermissionGroup>(tables.groups)).filter((group) => group.cube === cube)
      }),
    addGroupMember: (actor, groupId, userId) =>
      Effect.gen(function* () {
        const group = yield* administer(actor, groupId)
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
        const group = yield* administer(actor, groupId)
        const membership = (yield* state.store.all<StoredMembership>(tables.memberships)).find(
          (item) => item.deleted !== true && item.groupId === groupId && item.userId === userId,
        )
        if (!membership) {
          return yield* Effect.fail(new PermissionNotFound({ message: "membership does not exist" }))
        }
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
