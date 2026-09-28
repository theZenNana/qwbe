import { DateTime, Effect, Option } from "effect"
import type { GroupMembership, PermissionGroup, PermissionService } from "qwbe-core/permissions"
import { PermissionForbidden, PermissionInvalid, PermissionNotFound } from "qwbe-core/permissions"
import type { PermissionState, StoredMembership } from "./state.ts"
import { tables } from "./state.ts"

export const groupById = (state: PermissionState, groupId: string) =>
  Effect.map(state.store.first<PermissionGroup>(tables.groups, { field: "id", value: groupId }), Option.getOrUndefined)

const memberWhere = (groupId: string, userId: string) => [
  { field: "groupId", value: groupId },
  { field: "userId", value: userId },
]

export const groupsFrom = (
  state: PermissionState,
): Pick<
  PermissionService,
  "createGroup" | "renameGroup" | "groups" | "addGroupMember" | "removeGroupMember" | "groupMembers"
> => {
  const requireCubeAccess = (actor: Parameters<PermissionService["createGroup"]>[0], cube: string) =>
    Effect.gen(function* () {
      if (actor.roles.includes("admin") || (yield* state.cubeAdmin(actor, cube))) return
      const owns = Option.isSome(
        yield* state.store.first(tables.ownership, [
          { field: "cube", value: cube },
          { field: "ownerId", value: actor.userId },
        ]),
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
        const createdAt = DateTime.formatIso(yield* DateTime.now)
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
        return yield* state.store.where<PermissionGroup>(tables.groups, { field: "cube", value: cube })
      }),
    addGroupMember: (actor, groupId, userId) =>
      Effect.gen(function* () {
        const group = yield* administer(actor, groupId)
        const existing = Option.getOrUndefined(
          yield* state.store.first<StoredMembership>(tables.memberships, memberWhere(groupId, userId)),
        )
        if (existing) return existing
        const createdAt = DateTime.formatIso(yield* DateTime.now)
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
        const membership = Option.getOrUndefined(
          yield* state.store.first<StoredMembership>(tables.memberships, memberWhere(groupId, userId)),
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
    groupMembers: (actor, groupId) =>
      Effect.gen(function* () {
        yield* administer(actor, groupId)
        // `every` pages through the store filtered by groupId, so the list is complete
        // whatever the store page size; soft-deleted memberships are excluded here.
        const rows = yield* state.every<StoredMembership>(tables.memberships, "groupId", groupId)
        return rows.filter((item) => item.deleted !== true)
      }),
  }
}
