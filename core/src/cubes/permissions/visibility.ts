import { Effect, Option } from "effect"
import type {
  EntityRef,
  EntityVisibility,
  Ownership,
  PermissionActor,
  PermissionService,
  VisibilityView,
} from "qwbe-core/permissions"
import {
  grantAccess,
  matchesVisibilityView,
  PermissionForbidden,
  PermissionNotFound,
  TotalActions,
} from "qwbe-core/permissions"
import type { HiddenPreference, PermissionState, StoredGrant } from "./state.ts"
import { refWhere, tables } from "./state.ts"

type Actor = Pick<PermissionActor, "userId" | "roles">

/** What the visibility rule reads about one entity besides its ownership row. */
type EntityFacts = Readonly<{
  grants: ReadonlyArray<StoredGrant>
  groupIds: ReadonlySet<string>
  admin: boolean
  hidden: boolean
}>

/** What the visibility rule reads about a whole cube, keyed by `entityKey`. */
type CubeFacts = Readonly<{
  owners: ReadonlyArray<Ownership>
  grants: ReadonlyMap<string, ReadonlyArray<StoredGrant>>
  hidden: ReadonlySet<string>
  groupIds: ReadonlySet<string>
  admin: boolean
}>

const hiddenWhere = (userId: string, ref: EntityRef) => [{ field: "userId", value: userId }, ...refWhere(ref)]

const entityKey = (ref: Pick<EntityRef, "entityType" | "entityId">) => JSON.stringify([ref.entityType, ref.entityId])

const refOf = (owner: Ownership): EntityRef => ({
  cube: owner.cube,
  entityType: owner.entityType,
  entityId: owner.entityId,
})

/** Why the actor sees the entity, first match wins; `undefined` when nothing lets them. */
const accessOf = (
  actor: Actor,
  owner: Pick<Ownership, "ownerId" | "createdBy">,
  granted: EntityVisibility["access"] | undefined,
  admin: boolean,
): EntityVisibility["access"] | undefined => {
  if (owner.ownerId === actor.userId) return { source: "owner", name: actor.userId, actions: TotalActions }
  if (granted) return granted
  if (owner.createdBy === actor.userId && admin) return { source: "creator", name: actor.userId, actions: TotalActions }
  if (actor.roles.includes("admin")) return { source: "superadmin", name: actor.userId, actions: TotalActions }
  if (admin) return { source: "cube-admin", name: actor.userId, actions: TotalActions }
  return undefined
}

/** The visibility rules over preloaded data: `undefined` when the actor may not see the entity. */
const decide = (actor: Actor, owner: Ownership, facts: EntityFacts): EntityVisibility | undefined => {
  const access = accessOf(actor, owner, grantAccess(actor.userId, facts.groupIds, facts.grants), facts.admin)
  if (!access) return undefined
  return {
    ...refOf(owner),
    ownerId: owner.ownerId,
    createdBy: owner.createdBy,
    createdAt: owner.createdAt,
    access,
    hidden: facts.hidden,
    sharedWithCount: facts.grants.length,
  }
}

const byEntity = (grants: ReadonlyArray<StoredGrant>) => {
  const grouped = new Map<string, Array<StoredGrant>>()
  for (const grant of grants) {
    const key = entityKey(grant)
    const list = grouped.get(key)
    if (list) list.push(grant)
    else grouped.set(key, [grant])
  }
  return grouped
}

/** `decide` per owned entity of the cube, in memory, keeping the rows `view` shows. */
const visibleRows = (actor: Actor, cube: CubeFacts, view: VisibilityView) =>
  cube.owners.flatMap((owner) => {
    const key = entityKey(owner)
    const row = decide(actor, owner, {
      grants: cube.grants.get(key) ?? [],
      groupIds: cube.groupIds,
      admin: cube.admin,
      hidden: cube.hidden.has(key),
    })
    return row !== undefined && matchesVisibilityView(row, actor.userId, view) ? [row] : []
  })

const loadEntityFacts = (
  state: Pick<PermissionState, "store" | "grantsFor" | "groupIdsFor" | "cubeAdmin">,
  actor: PermissionActor,
  ref: EntityRef,
) =>
  Effect.gen(function* () {
    const grants = yield* state.grantsFor(ref)
    const groupIds = yield* state.groupIdsFor(actor.userId)
    const admin = yield* state.cubeAdmin(actor, ref.cube)
    const hidden = Option.isSome(yield* state.store.first(tables.hidden, hiddenWhere(actor.userId, ref)))
    return { grants, groupIds, admin, hidden }
  })

/** One read per table for the whole cube: ownership, grants, hidden, memberships, cube admin. */
const loadCubeFacts = (
  state: Pick<PermissionState, "store" | "groupIdsFor" | "cubeAdmin">,
  actor: PermissionActor,
  cube: string,
) =>
  Effect.gen(function* () {
    const byCube = { field: "cube", value: cube }
    const owners = yield* state.store.where<Ownership>(tables.ownership, byCube)
    const grants = byEntity(yield* state.store.where<StoredGrant>(tables.grants, byCube))
    const hidden = new Set(
      (yield* state.store.where<HiddenPreference>(tables.hidden, [
        { field: "userId", value: actor.userId },
        byCube,
      ])).map(entityKey),
    )
    const groupIds = yield* state.groupIdsFor(actor.userId)
    const admin = yield* state.cubeAdmin(actor, cube)
    return { owners, grants, hidden, groupIds, admin }
  })

/** Inserts or soft-deletes the actor's hidden preference so it matches `hidden`. */
const writeHidden = (store: PermissionState["store"], userId: string, ref: EntityRef, hidden: boolean) =>
  Effect.gen(function* () {
    const existing = Option.getOrUndefined(
      yield* store.first<HiddenPreference>(tables.hidden, hiddenWhere(userId, ref)),
    )
    if (hidden && !existing) yield* store.insert(tables.hidden, "HiddenPreference", "hidden", { ...ref, userId })
    if (!hidden && existing) yield* store.update(tables.hidden, existing.id, { deleted: true })
  })

const requireVisible = (row: EntityVisibility | undefined) =>
  row ? Effect.succeed(row) : Effect.fail(new PermissionForbidden({ message: "entity is not visible to this user" }))

export const visibilityFrom = (state: PermissionState): Pick<PermissionService, "listVisible" | "setHidden"> => {
  const visibilityFor = (actor: PermissionActor, owner: Ownership) =>
    Effect.map(loadEntityFacts(state, actor, refOf(owner)), (facts) => decide(actor, owner, facts))
  return {
    listVisible: (actor, cube, view) =>
      Effect.map(loadCubeFacts(state, actor, cube), (facts) => visibleRows(actor, facts, view)),
    setHidden: (actor, ref, hidden) =>
      Effect.gen(function* () {
        const owner = yield* state.ownership(ref)
        if (!owner) {
          return yield* Effect.fail(new PermissionNotFound({ message: "entity has no ownership record" }))
        }
        const visible = yield* requireVisible(yield* visibilityFor(actor, owner))
        yield* writeHidden(state.store, actor.userId, ref, hidden)
        const changed = yield* requireVisible(yield* visibilityFor(actor, owner))
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
