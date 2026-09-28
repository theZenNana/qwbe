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
import type { ListWhere, PageRequest } from "../../kernel/pagination.ts"
import type { HiddenPreference, PermissionState, StoredGrant, StoredOwnership } from "./state.ts"
import { entityKeyOf, refWhere, tables } from "./state.ts"

type Actor = Pick<PermissionActor, "userId" | "roles">

/** What the visibility rule reads about one entity besides its ownership row. */
type EntityFacts = Readonly<{
  grants: ReadonlyArray<StoredGrant>
  groupIds: ReadonlySet<string>
  admin: boolean
  hidden: boolean
}>

const hiddenWhere = (userId: string, ref: EntityRef) => [{ field: "userId", value: userId }, ...refWhere(ref)]

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
export const decide = (actor: Actor, owner: Ownership, facts: EntityFacts): EntityVisibility | undefined => {
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
    const key = entityKeyOf(grant)
    const list = grouped.get(key)
    if (list) list.push(grant)
    else grouped.set(key, [grant])
  }
  return grouped
}

/** Whether a grant names the actor or one of its groups: the subjects `grantAccess` counts. */
const namesActor = (actor: Actor, groupIds: ReadonlySet<string>, grant: StoredGrant) =>
  grant.subject.kind === "user" ? grant.subject.userId === actor.userId : groupIds.has(grant.subject.groupId)

/**
 * The ownership rows `decide` + `matchesVisibilityView` keep, as a store predicate. `accessOf`
 * gives access to an admin (superadmin or cube admin) for every row, else to the owner or a
 * grantee: a creator counts only with admin, which already sees all. The stored `sharedWithCount`
 * is recounted on every grant change, so it equals the live grant count `decide` reports.
 */
const visibleWhere = (
  actor: Actor,
  cube: string,
  view: VisibilityView,
  access: Readonly<{ admin: boolean; granted: ReadonlyArray<string>; hidden: ReadonlyArray<string> }>,
): ListWhere => {
  const me = { field: "ownerId", value: actor.userId }
  const unshared = { field: "sharedWithCount", value: "0" }
  const hidden = [{ field: "entityKey", values: access.hidden }]
  const equals = [{ field: "cube", value: cube }]
  if (view === "owned-by-me" || view === "only-mine" || view === "shared-by-me") equals.push(me)
  if (view === "only-mine") equals.push(unshared)
  if (view === "created-by-me") equals.push({ field: "createdBy", value: actor.userId })
  const excluded: Array<ListWhere> = view === "hidden-by-me" ? [] : [{ in: hidden }]
  if (view === "shared-by-me") excluded.push({ equals: [unshared] })
  if (view === "shared-with-me") excluded.push({ equals: [me] })
  return {
    equals,
    ...(view === "hidden-by-me" ? { in: hidden } : {}),
    ...(access.admin ? {} : { anyOf: [{ equals: [me] }, { in: [{ field: "entityKey", values: access.granted }] }] }),
    ...(excluded.length > 0 ? { not: { anyOf: excluded } } : {}),
  }
}

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

/**
 * One page of `view`: the store filters, sorts, counts and pages the ownership rows, then `decide`
 * runs on the page's rows only, with their grants read by `in` on the page's keys.
 */
const listPage = (
  state: PermissionState,
  actor: PermissionActor,
  cube: string,
  view: VisibilityView,
  page: PageRequest,
) =>
  Effect.gen(function* () {
    const byCube = { field: "cube", value: cube }
    const groupIds = yield* state.groupIdsFor(actor.userId)
    const admin = yield* state.cubeAdmin(actor, cube)
    // ponytail: reads every grant of the cube to find the actor's; a `subjectKey` on grants
    // (as capabilities have) lets the store pick them when a cube's grants outgrow memory.
    const granted = admin
      ? []
      : (yield* state.store.where<StoredGrant>(tables.grants, byCube))
          .filter((grant) => namesActor(actor, groupIds, grant))
          .map(entityKeyOf)
    const hidden = new Set(
      (yield* state.store.where<HiddenPreference>(tables.hidden, [
        { field: "userId", value: actor.userId },
        byCube,
      ])).map(entityKeyOf),
    )
    const found = yield* state.store.page<StoredOwnership>(
      tables.ownership,
      page,
      visibleWhere(actor, cube, view, { admin, granted: [...new Set(granted)], hidden: [...hidden] }),
    )
    const keys = found.rows.map(entityKeyOf)
    const grants = byEntity(
      keys.length === 0
        ? []
        : yield* state.store.where<StoredGrant>(tables.grants, { in: [{ field: "entityKey", values: keys }] }),
    )
    // The predicate expresses the rule; a row the rule still refuses is dropped, never shown.
    const rows = found.rows.flatMap((owner) => {
      const key = entityKeyOf(owner)
      const row = decide(actor, owner, {
        grants: grants.get(key) ?? [],
        groupIds,
        admin,
        hidden: hidden.has(key),
      })
      return row !== undefined && matchesVisibilityView(row, actor.userId, view) ? [row] : []
    })
    yield* state
      .writeAudit(actor, { cube, entityType: "*", entityId: "*" }, "visibility.list", "allowed", null, {
        view,
        sortBy: found.sortedBy,
        descending: page.descending ?? false,
        offset: found.offset,
        limit: found.limit,
        total: found.total,
      })
      .pipe(Effect.orDie) // plain strings and numbers: the JSON check cannot refuse them
    return { ...found, rows }
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
    listVisible: (actor, cube, view, page) => listPage(state, actor, cube, view, page),
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
