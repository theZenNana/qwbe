import { DateTime, Effect } from "effect"
import type {
  AccessDecision,
  EntityRef,
  GrantAction,
  Ownership,
  PermissionActor,
  PermissionService,
} from "qwbe-core/permissions"
import { PermissionConflict, PermissionForbidden, PermissionNotFound } from "qwbe-core/permissions"
import type { PermissionState, StoredGrant, StoredOwnership } from "./state.ts"
import { tables } from "./state.ts"

export type Foundation = Pick<PermissionService, "claim" | "ownership" | "authorize" | "transferOwnership"> & {
  readonly decide: (actor: PermissionActor, ref: EntityRef, action: GrantAction) => Effect.Effect<AccessDecision>
  readonly requireShare: (actor: PermissionActor, ref: EntityRef) => Effect.Effect<void, PermissionForbidden>
  /** Every entity id of `scope` for which `decide` allows `action`, or "all" for admins; no audit. */
  readonly visibleIds: (
    actor: PermissionActor,
    scope: { readonly cube: string; readonly entityType: string },
    action: GrantAction,
  ) => Effect.Effect<"all" | ReadonlySet<string>>
}

/** Whether `grant` gives `action` to the actor, directly or through one of `groups`. */
const grants = (actor: PermissionActor, groups: ReadonlySet<string>, grant: StoredGrant, action: GrantAction) =>
  grant.actions.includes(action) &&
  ((grant.subject.kind === "user" && grant.subject.userId === actor.userId) ||
    (grant.subject.kind === "group" && groups.has(grant.subject.groupId)))

export const foundationFrom = (state: PermissionState): Foundation => {
  const decide = (actor: PermissionActor, ref: EntityRef, action: GrantAction) =>
    Effect.gen(function* () {
      if (actor.roles.includes("admin")) return { allowed: true, source: "superadmin" } as const
      if (yield* state.cubeAdmin(actor, ref.cube)) return { allowed: true, source: "cube-admin" } as const
      const owner = yield* state.ownership(ref)
      if (owner?.ownerId === actor.userId) return { allowed: true, source: "owner" } as const
      const groups = yield* state.groupIdsFor(actor.userId)
      const grant = (yield* state.grantsFor(ref)).find((candidate) => grants(actor, groups, candidate, action))
      return grant ? ({ allowed: true, source: "grant" } as const) : ({ allowed: false, source: "none" } as const)
    })
  const authorize = (actor: PermissionActor, ref: EntityRef, action: GrantAction) =>
    Effect.gen(function* () {
      const result: AccessDecision = yield* decide(actor, ref, action)
      yield* state.writeAudit(
        actor,
        ref,
        ["entity", action].join("."),
        result.allowed ? "allowed" : "denied",
        null,
        result,
      )
      return result
    })
  return {
    claim: (actor, ref) =>
      Effect.gen(function* () {
        if (yield* state.ownership(ref))
          return yield* Effect.fail(
            new PermissionConflict({ message: ["entity", ref.entityId, "is already claimed"].join(" ") }),
          )
        const createdAt = DateTime.formatIso(yield* DateTime.now)
        const value: Ownership = { ...ref, ownerId: actor.userId, createdBy: actor.userId, createdAt }
        yield* state.store.insert(tables.ownership, "Ownership", "own", value)
        yield* state.writeAudit(actor, ref, "ownership.claim", "success", null, value)
        return value
      }),
    ownership: state.ownership,
    authorize,
    transferOwnership: (actor, ref, userId) =>
      Effect.gen(function* () {
        const current = yield* state.ownership(ref)
        if (!current) {
          return yield* Effect.fail(new PermissionNotFound({ message: "entity has no ownership record" }))
        }
        const access = yield* decide(actor, ref, "transfer")
        if (!access.allowed)
          return yield* Effect.fail(
            new PermissionForbidden({ message: "only an authorized owner or administrator may transfer ownership" }),
          )
        yield* state.store.update(tables.ownership, current.id, { ownerId: userId })
        const changed: Ownership = { ...current, ownerId: userId }
        yield* state.writeAudit(actor, ref, "ownership.transfer", "success", current, changed)
        return changed
      }),
    decide,
    visibleIds: (actor, scope, action) =>
      Effect.gen(function* () {
        if (actor.roles.includes("admin") || (yield* state.cubeAdmin(actor, scope.cube))) return "all" as const
        const where = [
          { field: "cube", value: scope.cube },
          { field: "entityType", value: scope.entityType },
        ]
        // Rows come oldest first and `decide` trusts only the oldest ownership row of an entity, so a
        // later duplicate claim must not make the actor an owner.
        // ponytail: reads every ownership row of the type; read by ownerId if that grows too big.
        const owners = new Map<string, string>()
        for (const row of yield* state.store.where<StoredOwnership>(tables.ownership, where))
          if (!owners.has(row.entityId)) owners.set(row.entityId, row.ownerId)
        const ids = new Set([...owners].filter(([, ownerId]) => ownerId === actor.userId).map(([id]) => id))
        const groups = yield* state.groupIdsFor(actor.userId)
        for (const grant of yield* state.store.where<StoredGrant>(tables.grants, where))
          if (grants(actor, groups, grant, action)) ids.add(grant.entityId)
        return ids
      }),
    requireShare: (actor, ref) =>
      Effect.gen(function* () {
        if (actor.roles.includes("admin")) return
        if (yield* state.cubeAdmin(actor, ref.cube)) return
        const owner = yield* state.ownership(ref)
        if (owner?.ownerId === actor.userId) return
        return yield* Effect.fail(
          new PermissionForbidden({ message: "only owner, cube admin or superadmin may share this entity" }),
        )
      }),
  }
}
