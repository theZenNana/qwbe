import { Effect, Schema } from "effect"
import type { EntityGrant, PermissionService } from "qwbe-core/permissions"
import { EntityGrantSchema, PermissionInvalid, PermissionNotFound, TotalActions } from "qwbe-core/permissions"
import type { Foundation } from "./foundation.ts"
import { groupById } from "./groups.ts"
import type { PermissionState, StoredGrant } from "./state.ts"
import { tables } from "./state.ts"

export const sharingFrom = (
  state: PermissionState,
  foundation: Foundation,
): Pick<PermissionService, "grantUser" | "grantGroup" | "revokeGrant" | "listGrants"> => ({
  grantUser: (actor, ref, userId, actions = TotalActions) =>
    Effect.gen(function* () {
      yield* foundation.requireShare(actor, ref)
      if (actions.length === 0) {
        return yield* Effect.fail(new PermissionInvalid({ message: "a grant needs at least one action" }))
      }
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
      if (actions.length === 0) {
        return yield* Effect.fail(new PermissionInvalid({ message: "a grant needs at least one action" }))
      }
      const group = yield* groupById(state, groupId)
      if (!group) {
        return yield* Effect.fail(new PermissionNotFound({ message: ["group", groupId, "does not exist"].join(" ") }))
      }
      if (group.cube !== ref.cube) {
        return yield* Effect.fail(new PermissionInvalid({ message: "group belongs to another cube" }))
      }
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
      if (!grant) {
        return yield* Effect.fail(new PermissionNotFound({ message: ["grant", grantId, "does not exist"].join(" ") }))
      }
      yield* foundation.requireShare(actor, grant)
      yield* state.store.update(tables.grants, grantId, { deleted: true })
      yield* state.writeAudit(actor, grant, "grant.revoke", "success", grant, null)
    }),
  listGrants: (actor, ref) =>
    Effect.gen(function* () {
      yield* foundation.requireShare(actor, ref)
      const grants = yield* state.grantsFor(ref)
      return yield* Effect.forEach(grants, (grant) =>
        Schema.decodeUnknown(EntityGrantSchema)(grant).pipe(
          Effect.mapError(() => new PermissionInvalid({ message: "stored grant violates its runtime schema" })),
        ),
      )
    }),
})
