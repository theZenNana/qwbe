import assert from "node:assert/strict"
import { describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { baseTools, memoryStore } from "../../test-cube-tools.ts"
import { backfillCounts, reconcileCounts } from "./counts.ts"
import { cube } from "./index.ts"
import { serviceFrom } from "./service.ts"
import type { StoredGrant, StoredOwnership } from "./state.ts"
import { stateFrom, tables } from "./state.ts"

const ana = { userId: "ana", roles: [] }
const ref = { cube: "crm/contacts", entityType: "Contact", entityId: "contact-42" }
const key = "crm/contacts:Contact:contact-42"

const ownershipOf = (store: ReturnType<typeof memoryStore>) =>
  Effect.map(
    store.where<StoredOwnership>(tables.ownership, { field: "entityId", value: ref.entityId }),
    (rows) => rows[0],
  )

describe("permissions ownership keys and counts", () => {
  it.effect("claim stores the entity key and a zero count", () =>
    Effect.gen(function* () {
      const store = memoryStore()
      yield* serviceFrom(store, () => new Map()).claim(ana, ref)
      const owner = yield* ownershipOf(store)
      assert.equal(owner?.entityKey, key)
      assert.equal(owner?.sharedWithCount, 0)
    }),
  )

  it.effect("recounts after grant, double grant and revoke", () =>
    Effect.gen(function* () {
      const store = memoryStore()
      const service = serviceFrom(store, () => new Map())
      yield* service.claim(ana, ref)
      const first = yield* service.grantUser(ana, ref, "mihai")
      assert.equal((yield* ownershipOf(store))?.sharedWithCount, 1)
      yield* service.grantUser(ana, ref, "mihai")
      assert.equal((yield* ownershipOf(store))?.sharedWithCount, 2)
      const sales = yield* service.createGroup(ana, ref.cube, "Sales")
      yield* service.grantGroup(ana, ref, sales.id, ["read"])
      assert.equal((yield* ownershipOf(store))?.sharedWithCount, 3)
      yield* service.revokeGrant(ana, first.id)
      assert.equal((yield* ownershipOf(store))?.sharedWithCount, 2)
      const grants = yield* store.where<StoredGrant>(tables.grants, { field: "entityKey", value: key })
      assert.equal(grants.length, 2)
      yield* service.transferOwnership(ana, ref, "bob")
      assert.equal((yield* ownershipOf(store))?.sharedWithCount, 2)
      assert.deepEqual(yield* reconcileCounts(stateFrom(store)), [])
    }),
  )

  it.effect("backfill fills rows written before the fields existed, and a second run changes nothing", () =>
    Effect.gen(function* () {
      const store = memoryStore()
      const state = stateFrom(store)
      yield* store.insert(tables.ownership, "Ownership", "own", { ...ref, ownerId: "ana", createdBy: "ana" })
      const grant = { ...ref, actions: ["read"], createdBy: "ana" }
      yield* store.insert(tables.grants, "EntityGrant", "grant", { ...grant, subject: { kind: "user", userId: "a" } })
      yield* store.insert(tables.grants, "EntityGrant", "grant", { ...grant, subject: { kind: "user", userId: "b" } })
      assert.equal((yield* reconcileCounts(state)).length, 3)

      yield* backfillCounts(state)
      const owner = yield* ownershipOf(store)
      assert.equal(owner?.entityKey, key)
      assert.equal(owner?.sharedWithCount, 2)
      assert.deepEqual(yield* reconcileCounts(state), [])

      const before = JSON.stringify(yield* store.all(tables.ownership))
      yield* backfillCounts(state)
      assert.equal(JSON.stringify(yield* store.all(tables.ownership)), before)
    }),
  )

  it.effect("the cube runs the backfill as a boot layer, not at create", () =>
    Effect.gen(function* () {
      const tools = baseTools()
      const store = tools.store
      yield* store.insert(tables.ownership, "Ownership", "own", { ...ref, ownerId: "ana", createdBy: "ana" })
      const { layers } = cube.create(tools)
      assert.ok(layers)
      assert.equal((yield* ownershipOf(store))?.entityKey, undefined)

      yield* Effect.scoped(Layer.build(layers as Layer.Layer<unknown, unknown, never>))
      assert.equal((yield* ownershipOf(store))?.entityKey, key)
      assert.deepEqual(yield* reconcileCounts(stateFrom(store)), [])
    }),
  )

  it.effect("reconcile reports a stored count that drifted from the live grants", () =>
    Effect.gen(function* () {
      const store = memoryStore()
      const service = serviceFrom(store, () => new Map())
      yield* service.claim(ana, ref)
      yield* service.grantUser(ana, ref, "mihai")
      const owner = yield* ownershipOf(store)
      assert.ok(owner)
      yield* store.update(tables.ownership, owner.id, { sharedWithCount: 5 })
      assert.deepEqual(yield* reconcileCounts(stateFrom(store)), [
        { table: tables.ownership, id: owner.id, entityKey: key, stored: 5, live: 1 },
      ])
    }),
  )
})
