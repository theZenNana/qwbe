import { Effect } from "effect"
import type {
  AccessDecision,
  AuditEvent,
  AuditQuery,
  EntityRef,
  GrantAction,
  Ownership,
  PermissionActor,
  PermissionService,
} from "qwbe-core/permissions"
import type { PermissionState } from "./state.ts"
import { tables } from "./state.ts"

export type Foundation = Pick<
  PermissionService,
  "claim" | "ownership" | "authorize" | "assignCubeAdmin" | "cubeAdmins" | "transferOwnership" | "audit"
> & {
  readonly decide: (actor: PermissionActor, ref: EntityRef, action: GrantAction) => Effect.Effect<AccessDecision>
  readonly requireShare: (actor: PermissionActor, ref: EntityRef) => Effect.Effect<void, string>
}

export const foundationFrom = (state: PermissionState): Foundation => {
  const decide = (actor: PermissionActor, ref: EntityRef, action: GrantAction) =>
    Effect.gen(function* () {
      if (actor.roles.includes("admin")) return { allowed: true, source: "superadmin" } as const
      if (yield* state.cubeAdmin(actor, ref.cube)) return { allowed: true, source: "cube-admin" } as const
      const owner = yield* state.ownership(ref)
      if (owner?.ownerId === actor.userId) return { allowed: true, source: "owner" } as const
      const groups = yield* state.groupIdsFor(actor.userId)
      const grant = (yield* state.grantsFor(ref)).find(
        (candidate) =>
          candidate.actions.includes(action) &&
          ((candidate.subject.kind === "user" && candidate.subject.userId === actor.userId) ||
            (candidate.subject.kind === "group" && groups.has(candidate.subject.groupId))),
      )
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
          return yield* Effect.fail(["entity", ref.entityId, "is already claimed"].join(" "))
        const createdAt = new Date().toISOString()
        const value: Ownership = { ...ref, ownerId: actor.userId, createdBy: actor.userId, createdAt }
        yield* state.store.insert(tables.ownership, "Ownership", "own", value)
        yield* state.writeAudit(actor, ref, "ownership.claim", "success", null, value)
        return value
      }),
    ownership: state.ownership,
    authorize,
    assignCubeAdmin: (actor, cube, userId) =>
      Effect.gen(function* () {
        if (!actor.roles.includes("admin") && !(yield* state.cubeAdmin(actor, cube))) {
          return yield* Effect.fail("only superadmin or cube admin may assign cube admins")
        }
        const existing = (yield* state.store.all<{ id: string; cube: string; userId: string }>(tables.cubeAdmins)).find(
          (row) => row.cube === cube && row.userId === userId,
        )
        if (!existing) yield* state.store.insert(tables.cubeAdmins, "CubeAdmin", "cadm", { cube, userId })
        yield* state.writeAudit(
          actor,
          { cube, entityType: "Cube", entityId: cube },
          "cube-admin.assign",
          "success",
          existing ?? null,
          { cube, userId },
        )
      }),
    cubeAdmins: (actor, cube) =>
      Effect.gen(function* () {
        if (!actor.roles.includes("admin") && !(yield* state.cubeAdmin(actor, cube))) {
          return yield* Effect.fail("only superadmin or cube admin may list cube admins")
        }
        return (yield* state.store.all<{ id: string; cube: string; userId: string }>(tables.cubeAdmins)).filter(
          (row) => row.cube === cube,
        )
      }),
    transferOwnership: (actor, ref, userId) =>
      Effect.gen(function* () {
        const current = yield* state.ownership(ref)
        if (!current) return yield* Effect.fail("entity has no ownership record")
        const access = yield* decide(actor, ref, "transfer")
        if (!access.allowed)
          return yield* Effect.fail("only an authorized owner or administrator may transfer ownership")
        yield* state.store.update(tables.ownership, current.id, { ownerId: userId })
        const changed: Ownership = { ...current, ownerId: userId }
        yield* state.writeAudit(actor, ref, "ownership.transfer", "success", current, changed)
        return changed
      }),
    audit: (query: AuditQuery = {}) =>
      Effect.map(state.store.all<AuditEvent>(tables.audit), (events) =>
        events.filter(
          (event) =>
            (!query.actorUserId || event.actorUserId === query.actorUserId) &&
            (!query.groupId ||
              (typeof event.after === "object" &&
                event.after !== null &&
                "groupId" in event.after &&
                event.after.groupId === query.groupId)) &&
            (!query.cube || event.cube === query.cube) &&
            (!query.entityType || event.entityType === query.entityType) &&
            (!query.entityId || event.entityId === query.entityId) &&
            (!query.action || event.action === query.action) &&
            (!query.result || event.result === query.result) &&
            (!query.from || event.timestamp >= query.from) &&
            (!query.to || event.timestamp <= query.to),
        ),
      ),
    decide,
    requireShare: (actor, ref) =>
      Effect.gen(function* () {
        if (actor.roles.includes("admin")) return
        if (yield* state.cubeAdmin(actor, ref.cube)) return
        const owner = yield* state.ownership(ref)
        if (owner?.ownerId === actor.userId) return
        return yield* Effect.fail("only owner, cube admin or superadmin may share this entity")
      }),
  }
}
