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
import { entityKeyOf, tables } from "./state.ts"

type Scope = Readonly<{ cube: string; entityType: string }>

export type Foundation = Pick<
  PermissionService,
  "claim" | "ownership" | "authorize" | "authorizeList" | "auditList" | "transferOwnership"
> & {
  readonly decide: (actor: PermissionActor, ref: EntityRef, action: GrantAction) => Effect.Effect<AccessDecision>
  readonly requireShare: (actor: PermissionActor, ref: EntityRef) => Effect.Effect<void, PermissionForbidden>
  /** Every entity id of `scope` for which `decide` allows `action`, or "all" for admins; no audit. */
  readonly visibleIds: (
    actor: PermissionActor,
    scope: Scope,
    action: GrantAction,
  ) => Effect.Effect<"all" | ReadonlySet<string>>
}

/** Whether `grant` gives `action` to the actor, directly or through one of `groups`. */
const grants = (
  actor: Pick<PermissionActor, "userId">,
  groups: ReadonlySet<string>,
  grant: StoredGrant,
  action: GrantAction,
) =>
  grant.actions.includes(action) &&
  ((grant.subject.kind === "user" && grant.subject.userId === actor.userId) ||
    (grant.subject.kind === "group" && groups.has(grant.subject.groupId)))

const scopeWhere = (scope: Scope) => [
  { field: "cube", value: scope.cube },
  { field: "entityType", value: scope.entityType },
]

/**
 * `decide` trusts only the oldest ownership row of an entity, so a later duplicate claim must not
 * make the actor an owner: keep an id only if its oldest row is the actor's. `rows` come oldest
 * first, so the first row seen per entity is the one `decide` trusts.
 */
const oldestOwnedBy = (rows: ReadonlyArray<StoredOwnership>, userId: string) => {
  const oldest = new Map<string, StoredOwnership>()
  for (const row of rows) if (!oldest.has(row.entityId)) oldest.set(row.entityId, row)
  return [...oldest].filter(([, row]) => row.ownerId === userId).map(([entityId]) => entityId)
}

/** Every ownership row of the entities in `scope` the user has at least one row for. */
const ownershipRowsOf = (store: PermissionState["store"], scope: Scope, userId: string) =>
  Effect.gen(function* () {
    const where = scopeWhere(scope)
    const mine = yield* store.where<StoredOwnership>(tables.ownership, [...where, { field: "ownerId", value: userId }])
    return yield* store.where<StoredOwnership>(tables.ownership, {
      equals: where,
      in: [{ field: "entityId", values: [...new Set(mine.map((row) => row.entityId))] }],
    })
  })

const decider =
  (state: Pick<PermissionState, "cubeAdmin" | "ownership" | "groupIdsFor" | "grantsFor">): Foundation["decide"] =>
  (actor, ref, action) =>
    Effect.gen(function* () {
      if (actor.roles.includes("admin")) return { allowed: true, source: "superadmin" } as const
      if (yield* state.cubeAdmin(actor, ref.cube)) return { allowed: true, source: "cube-admin" } as const
      const owner = yield* state.ownership(ref)
      if (owner?.ownerId === actor.userId) return { allowed: true, source: "owner" } as const
      const groups = yield* state.groupIdsFor(actor.userId)
      const grant = (yield* state.grantsFor(ref)).find((candidate) => grants(actor, groups, candidate, action))
      return grant ? ({ allowed: true, source: "grant" } as const) : ({ allowed: false, source: "none" } as const)
    })

const visibleIdsFrom =
  (state: Pick<PermissionState, "store" | "cubeAdmin" | "groupIdsFor">): Foundation["visibleIds"] =>
  (actor, scope, action) =>
    Effect.gen(function* () {
      if (actor.roles.includes("admin") || (yield* state.cubeAdmin(actor, scope.cube))) return "all" as const
      const owned = oldestOwnedBy(yield* ownershipRowsOf(state.store, scope, actor.userId), actor.userId)
      const groups = yield* state.groupIdsFor(actor.userId)
      const shared = yield* state.store.where<StoredGrant>(tables.grants, scopeWhere(scope))
      const granted = shared.filter((grant) => grants(actor, groups, grant, action)).map((grant) => grant.entityId)
      return new Set([...owned, ...granted])
    })

export const foundationFrom = (state: PermissionState): Foundation => {
  const decide = decider(state)
  const visibleIds = visibleIdsFrom(state)
  const auditDecision = (actor: PermissionActor, ref: EntityRef, action: GrantAction, result: AccessDecision) =>
    state.writeAudit(actor, ref, ["entity", action].join("."), result.allowed ? "allowed" : "denied", null, result)
  return {
    claim: (actor, ref) =>
      Effect.gen(function* () {
        if (yield* state.ownership(ref))
          return yield* Effect.fail(
            new PermissionConflict({ message: ["entity", ref.entityId, "is already claimed"].join(" ") }),
          )
        const createdAt = DateTime.formatIso(yield* DateTime.now)
        const value: Ownership = { ...ref, ownerId: actor.userId, createdBy: actor.userId, createdAt }
        // An admin may have shared the entity before anyone claimed it, so count, do not assume 0.
        const sharedWithCount = (yield* state.grantsFor(ref)).length
        yield* state.store.insert(tables.ownership, "Ownership", "own", {
          ...value,
          entityKey: entityKeyOf(ref),
          sharedWithCount,
        })
        yield* state.writeAudit(actor, ref, "ownership.claim", "success", null, value)
        return value
      }),
    ownership: state.ownership,
    authorize: (actor, ref, action) =>
      Effect.tap(decide(actor, ref, action), (result) => auditDecision(actor, ref, action, result)),
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
        yield* state.recountShares(ref)
        const changed: Ownership = { ...current, ownerId: userId }
        yield* state.writeAudit(actor, ref, "ownership.transfer", "success", current, changed)
        return changed
      }),
    decide,
    visibleIds,
    authorizeList: visibleIds,
    // The audit row needs one entityId; a list covers many, so "*" names the scope and the page's
    // ids travel in `after`.
    auditList: (actor, scope, action, source, returnedIds) =>
      state.writeAudit(actor, { ...scope, entityId: "*" }, "entity.list", "allowed", null, {
        action,
        source,
        ids: [...returnedIds],
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
