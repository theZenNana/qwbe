import assert from "node:assert/strict"
import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { PermissionForbidden, PermissionInvalid, TotalActions } from "qwbe-core/permissions"
import { cube } from "./index.ts"
import { pagingStore } from "./test-store.ts"

const tools = () => ({
  store: pagingStore(),
  bus: { publish: () => Effect.void },
  catalogue: () => [],
  permissions: () => new Map(),
  commands: () => [],
})

const ana = { userId: "ana", roles: ["reader"] }
const ref = { cube: "crm/contacts", entityType: "Contact", entityId: "contact-42" }

describe("permissions sharing capability", () => {
  it.effect("gives a direct @username grant TOTAL access by default", () =>
    Effect.gen(function* () {
      const service = cube.create(tools()).entityPermissions
      assert.ok(service)
      yield* service.claim(ana, ref)
      const grant = yield* service.grantUser(ana, ref, "mihai")
      assert.deepEqual(grant.actions, TotalActions)
      assert.deepEqual(yield* service.listGrants(ana, ref), [grant])
      assert.deepEqual(yield* service.authorize({ userId: "mihai", roles: [] }, ref, "transfer"), {
        allowed: true,
        source: "grant",
      })
    }),
  )

  it.effect("combines group membership with a custom READ grant", () =>
    Effect.gen(function* () {
      const service = cube.create(tools()).entityPermissions
      assert.ok(service)
      yield* service.claim(ana, ref)
      const sales = yield* service.createGroup(ana, ref.cube, "Sales")
      yield* service.addGroupMember(ana, sales.id, "ioana")
      yield* service.grantGroup(ana, ref, sales.id, ["read"])
      assert.equal((yield* service.authorize({ userId: "ioana", roles: [] }, ref, "read")).allowed, true)
      assert.equal((yield* service.authorize({ userId: "ioana", roles: [] }, ref, "edit")).allowed, false)
    }),
  )

  it.effect("refuses a group grant across cube boundaries", () =>
    Effect.gen(function* () {
      const service = cube.create(tools()).entityPermissions
      assert.ok(service)
      yield* service.claim(ana, ref)
      const sales = yield* service.createGroup({ userId: "root", roles: ["admin"] }, "crm/contracts", "Sales")
      assert.match((yield* Effect.flip(service.grantGroup(ana, ref, sales.id, ["read"]))).message, /another cube/)
    }),
  )

  it.effect("refuses membership changes from someone who did not create the group", () =>
    Effect.gen(function* () {
      const service = cube.create(tools()).entityPermissions
      assert.ok(service)
      yield* service.claim(ana, ref)
      const sales = yield* service.createGroup(ana, ref.cube, "Sales")
      assert.ok(
        (yield* Effect.flip(service.addGroupMember({ userId: "stranger", roles: [] }, sales.id, "ioana"))) instanceof
          PermissionForbidden,
      )
    }),
  )

  it.effect("rejects an empty grant action set as typed invalid input", () =>
    Effect.gen(function* () {
      const service = cube.create(tools()).entityPermissions
      assert.ok(service)
      yield* service.claim(ana, ref)
      assert.ok((yield* Effect.flip(service.grantUser(ana, ref, "mihai", []))) instanceof PermissionInvalid)
    }),
  )

  it.effect("stops a user grant from authorizing after revocation", () =>
    Effect.gen(function* () {
      const service = cube.create(tools()).entityPermissions
      assert.ok(service)
      yield* service.claim(ana, ref)
      const grant = yield* service.grantUser(ana, ref, "mihai", ["read"])
      yield* service.revokeGrant(ana, grant.id)
      assert.equal((yield* service.authorize({ userId: "mihai", roles: [] }, ref, "read")).allowed, false)
    }),
  )

  it.effect("does not let a TOTAL grantee share the entity again", () =>
    Effect.gen(function* () {
      const service = cube.create(tools()).entityPermissions
      assert.ok(service)
      yield* service.claim(ana, ref)
      yield* service.grantUser(ana, ref, "mihai")
      assert.match(
        (yield* Effect.flip(service.grantUser({ userId: "mihai", roles: [] }, ref, "ioana"))).message,
        /only owner, cube admin or superadmin/,
      )
    }),
  )

  it.effect("records filterable grant audit with linked before/after trace", () =>
    Effect.gen(function* () {
      const service = cube.create(tools()).entityPermissions
      assert.ok(service)
      yield* service.claim(ana, ref)
      const sales = yield* service.createGroup(ana, ref.cube, "Sales")
      yield* service.grantGroup(ana, ref, sales.id, ["read"])
      const events = yield* service.audit({
        actorUserId: "ana",
        groupId: sales.id,
        cube: "crm/contacts",
        action: "grant.group",
      })
      assert.equal(events.length, 1)
      assert.equal(events[0]?.result, "success")
      assert.equal(events[0]?.before, null)
      assert.deepEqual(events[0]?.after, { groupId: sales.id, actions: ["read"] })
      assert.ok(events[0]?.traceId)
    }),
  )

  it.effect("matches a group audit filter against both before and after trace", () =>
    Effect.gen(function* () {
      const service = cube.create(tools()).entityPermissions
      assert.ok(service)
      yield* service.claim(ana, ref)
      const sales = yield* service.createGroup(ana, ref.cube, "Sales")
      const grant = yield* service.grantGroup(ana, ref, sales.id, ["read"])
      yield* service.revokeGrant(ana, grant.id)
      const events = yield* service.audit({ groupId: sales.id })
      assert.deepEqual(
        events.map((event) => event.action),
        ["grant.group", "grant.revoke"],
      )
    }),
  )

  it.effect("uses current cube ownership instead of permanent group creator privilege", () =>
    Effect.gen(function* () {
      const service = cube.create(tools()).entityPermissions
      assert.ok(service)
      yield* service.claim(ana, ref)
      const sales = yield* service.createGroup(ana, ref.cube, "Sales")
      yield* service.transferOwnership(ana, ref, "mihai")
      assert.ok(
        (yield* Effect.flip(service.renameGroup(ana, sales.id, "Old owner edit"))) instanceof PermissionForbidden,
      )
      assert.equal(
        (yield* service.renameGroup({ userId: "mihai", roles: [] }, sales.id, "Current owner edit")).name,
        "Current owner edit",
      )
    }),
  )

  it.effect("unites direct and every matching group grant in visibility provenance", () =>
    Effect.gen(function* () {
      const service = cube.create(tools()).entityPermissions
      assert.ok(service)
      yield* service.claim(ana, ref)
      const sales = yield* service.createGroup(ana, ref.cube, "Sales")
      const legal = yield* service.createGroup(ana, ref.cube, "Legal")
      yield* service.addGroupMember(ana, sales.id, "ioana")
      yield* service.addGroupMember(ana, legal.id, "ioana")
      yield* service.grantUser(ana, ref, "ioana", ["read"])
      yield* service.grantGroup(ana, ref, sales.id, ["edit"])
      yield* service.grantGroup(ana, ref, legal.id, ["delete", "read"])
      const row = (yield* service.listVisible({ userId: "ioana", roles: [] }, ref.cube, "all", {
        offset: 0,
        limit: 50,
      })).rows[0]
      assert.equal(row?.access.source, "user-grant")
      assert.deepEqual(row?.access.actions, ["read", "edit", "delete"])
    }),
  )
})
