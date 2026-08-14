import { Effect } from "effect"
import type { EntityGrant, PermissionService } from "qwbe-core/permissions"
import { TotalActions } from "qwbe-core/permissions"
import type { Foundation } from "./foundation.ts"
import { groupById } from "./groups.ts"
import type { PermissionState, StoredGrant } from "./state.ts"
import { tables } from "./state.ts"

export const sharingFrom = (
  state: PermissionState,
  foundation: Foundation,
): Pick<PermissionService, "grantUser" | "grantGroup" | "revokeGrant"> => ({
  grantUser: (actor, ref, userId, actions = TotalActions) =>
    Effect.gen(function* () {
      yield* foundation.requireShare(actor, ref)
      const createdAt = new Date().toISOString()
      const row = yield* state.store.insert(tables.grants, "EntityGrant", "grant", {
        ...ref,
        subject: { kind: "user", userId },
        actions,
        createdBy: actor.userId,
        createdAt,
      })
      const value: EntityGrant = {
        id: String(row.id),
        ...ref,
        subject: { kind: "user", userId },
        actions,
        createdBy: actor.userId,
        createdAt,
      }
      yield* state.writeAudit(actor, ref, "grant.user", "success", null, { userId, actions })
      return value
    }),
  grantGroup: (actor, ref, groupId, actions) =>
    Effect.gen(function* () {
      yield* foundation.requireShare(actor, ref)
      const group = yield* groupById(state, groupId)
      if (!group) return yield* Effect.fail(["group", groupId, "does not exist"].join(" "))
      if (group.cube !== ref.cube) return yield* Effect.fail("group belongs to another cube")
      const createdAt = new Date().toISOString()
      const row = yield* state.store.insert(tables.grants, "EntityGrant", "grant", {
        ...ref,
        subject: { kind: "group", groupId },
        actions,
        createdBy: actor.userId,
        createdAt,
      })
      const value: EntityGrant = {
        id: String(row.id),
        ...ref,
        subject: { kind: "group", groupId },
        actions,
        createdBy: actor.userId,
        createdAt,
      }
      yield* state.writeAudit(actor, ref, "grant.group", "success", null, { groupId, actions })
      return value
    }),
  revokeGrant: (actor, grantId) =>
    Effect.gen(function* () {
      const grant = (yield* state.store.all<StoredGrant>(tables.grants)).find(
        (item) => item.deleted !== true && item.id === grantId,
      )
      if (!grant) return yield* Effect.fail(["grant", grantId, "does not exist"].join(" "))
      yield* foundation.requireShare(actor, grant)
      yield* state.store.update(tables.grants, grantId, { deleted: true })
      yield* state.writeAudit(actor, grant, "grant.revoke", "success", grant, null)
    }),
})
