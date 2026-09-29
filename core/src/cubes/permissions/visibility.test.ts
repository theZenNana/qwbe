import assert from "node:assert/strict"
import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { EntityVisibility, PermissionActor, VisibilityView } from "qwbe-core/permissions"
import { matchesVisibilityView } from "qwbe-core/permissions"
import { serviceFrom } from "./service.ts"
import type { HiddenPreference, StoredGrant, StoredOwnership } from "./state.ts"
import { entityKeyOf, stateFrom, tables } from "./state.ts"
import { pagingStore } from "./test-store.ts"
import { decide } from "./visibility.ts"

const CUBE = "crm/contacts"
const VIEWS: ReadonlyArray<VisibilityView> = [
  "all",
  "owned-by-me",
  "created-by-me",
  "only-mine",
  "shared-by-me",
  "shared-with-me",
  "hidden-by-me",
]
const root = { userId: "root", roles: ["admin"] }
const ana = { userId: "ana", roles: [] }
const ioana = { userId: "ioana", roles: [] }
const mihai = { userId: "mihai", roles: [] }
const boss = { userId: "boss", roles: [] }
const stranger = { userId: "stranger", roles: [] }
const ACTORS = [root, ana, ioana, mihai, boss, stranger]
const at = (entityId: string) => ({ cube: CUBE, entityType: "Contact", entityId })
const all = { offset: 0, limit: 200 }

/**
 * c-1 shared with a group, c-2 with the group and ioana (ioana hid it), c-3 with mihai (ana hid
 * it), c-4 created by the cube admin and owned by ana, c-5 unshared and ioana's, c-6 with 10
 * grants, c-7 with 9; one deal in another cube.
 */
const seeded = () =>
  Effect.gen(function* () {
    const store = pagingStore()
    const service = serviceFrom(store, () => new Map())
    yield* service.assignCubeAdmin(root, CUBE, "boss")
    for (const id of ["c-1", "c-2", "c-3", "c-6", "c-7"]) yield* service.claim(ana, at(id))
    yield* service.claim(boss, at("c-4"))
    yield* service.transferOwnership(boss, at("c-4"), "ana")
    yield* service.claim(ioana, at("c-5"))
    yield* service.claim(ana, { cube: "crm/deals", entityType: "Deal", entityId: "d-1" })
    const sales = yield* service.createGroup(ana, CUBE, "Sales")
    yield* service.addGroupMember(ana, sales.id, "ioana")
    yield* service.grantGroup(ana, at("c-1"), sales.id, ["read"])
    yield* service.grantGroup(ana, at("c-2"), sales.id, ["read"])
    yield* service.grantUser(ana, at("c-2"), "ioana", ["edit"])
    yield* service.grantUser(ana, at("c-3"), "mihai")
    for (let n = 0; n < 10; n++) yield* service.grantUser(ana, at("c-6"), `u-${n}`)
    for (let n = 0; n < 9; n++) yield* service.grantUser(ana, at("c-7"), `u-${n}`)
    yield* service.setHidden(ioana, at("c-2"), true)
    yield* service.setHidden(ana, at("c-3"), true)
    return { store, service }
  })

/** The rule before paging: `decide` on every ownership row of the cube, kept when `view` shows it. */
const oldRule = (store: ReturnType<typeof pagingStore>, actor: PermissionActor, view: VisibilityView) =>
  Effect.gen(function* () {
    const state = stateFrom(store)
    const byCube = { field: "cube", value: CUBE }
    const owners = yield* store.where<StoredOwnership>(tables.ownership, byCube)
    const grants = yield* store.where<StoredGrant>(tables.grants, byCube)
    const hidden = new Set(
      (yield* store.where<HiddenPreference>(tables.hidden, [{ field: "userId", value: actor.userId }, byCube])).map(
        entityKeyOf,
      ),
    )
    const groupIds = yield* state.groupIdsFor(actor.userId)
    const admin = yield* state.cubeAdmin(actor, CUBE)
    return owners.flatMap((owner) => {
      const key = entityKeyOf(owner)
      const row = decide(actor, owner, {
        grants: grants.filter((grant) => entityKeyOf(grant) === key),
        groupIds,
        admin,
        hidden: hidden.has(key),
      })
      return row !== undefined && matchesVisibilityView(row, actor.userId, view) ? [row] : []
    })
  })

const bySet = (rows: ReadonlyArray<EntityVisibility>) => rows.map((row) => JSON.stringify(row)).sort()

describe("permissions listVisible paged by the store", () => {
  it.effect("returns the old rule's rows and total for every view and actor", () =>
    Effect.gen(function* () {
      const { store, service } = yield* seeded()
      for (const actor of ACTORS)
        for (const view of VIEWS) {
          const expected = yield* oldRule(store, actor, view)
          const page = yield* service.listVisible(actor, CUBE, view, all)
          assert.deepEqual(bySet(page.rows), bySet(expected), `${actor.userId} ${view}`)
          assert.equal(page.total, expected.length, `${actor.userId} ${view} total`)
        }
    }),
  )

  it.effect("keeps the access sources and hidden state of the single-entity rule", () =>
    Effect.gen(function* () {
      const { service } = yield* seeded()
      const sources: Record<string, Array<string>> = {}
      for (const actor of ACTORS) {
        const rows = [
          ...(yield* service.listVisible(actor, CUBE, "all", { ...all, sortBy: "entityId" })).rows,
          ...(yield* service.listVisible(actor, CUBE, "hidden-by-me", { ...all, sortBy: "entityId" })).rows,
        ]
        for (const row of rows) assert.deepEqual(row, yield* service.setHidden(actor, row, row.hidden))
        sources[actor.userId] = rows.map((row) => `${row.entityId}:${row.access.source}:${row.hidden}`)
      }
      assert.deepEqual(sources, {
        root: [1, 2, 3, 4, 5, 6, 7].map((n) => `c-${n}:superadmin:false`),
        ana: ["c-1:owner:false", "c-2:owner:false", "c-4:owner:false", "c-6:owner:false", "c-7:owner:false"].concat(
          "c-3:owner:true",
        ),
        ioana: ["c-1:group-grant:false", "c-5:owner:false", "c-2:user-grant:true"],
        mihai: ["c-3:user-grant:false"],
        boss: [1, 2, 3, 4, 5, 6, 7].map((n) => `c-${n}:${n === 4 ? "creator" : "cube-admin"}:false`),
        stranger: [],
      })
    }),
  )

  it.effect("sorts sharedWithCount as a number and pages with the store's total", () =>
    Effect.gen(function* () {
      const { service } = yield* seeded()
      const counts = (yield* service.listVisible(root, CUBE, "all", { ...all, sortBy: "sharedWithCount" })).rows.map(
        (row) => row.sharedWithCount,
      )
      assert.deepEqual(
        counts,
        [...counts].sort((a, b) => a - b),
      )
      assert.deepEqual(counts.slice(-2), [9, 10])
      const second = yield* service.listVisible(root, CUBE, "all", {
        offset: 2,
        limit: 2,
        sortBy: "sharedWithCount",
        descending: true,
      })
      assert.equal(second.total, 7)
      assert.equal(second.rows.length, 2)
      assert.equal(second.sortedBy, "sharedWithCount")
    }),
  )

  it.effect("writes one visibility.list audit row per request", () =>
    Effect.gen(function* () {
      const { store, service } = yield* seeded()
      yield* service.listVisible(ana, CUBE, "shared-by-me", { offset: 1, limit: 2, sortBy: "entityId" })
      const audit = yield* store.where<{ action: string; after: unknown }>(tables.audit, {
        field: "action",
        value: "visibility.list",
      })
      assert.deepEqual(
        audit.map((row) => row.after),
        [{ view: "shared-by-me", sortBy: "entityId", descending: false, offset: 1, limit: 2, total: 4 }],
      )
    }),
  )
})
