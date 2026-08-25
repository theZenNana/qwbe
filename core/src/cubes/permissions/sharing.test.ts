import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Effect } from "effect"
import type { CubeTools } from "qwbe-core/cube"
import { PermissionForbidden, PermissionInvalid, TotalActions } from "qwbe-core/permissions"
import { cube } from "./index.ts"

const memoryStore = (): CubeTools["store"] => {
  const tables = new Map<string, Array<Record<string, unknown>>>()
  let next = 0
  const rows = (table: string): Array<Record<string, unknown>> => {
    const existing = tables.get(table)
    if (existing) return existing
    const created: Array<Record<string, unknown>> = []
    tables.set(table, created)
    return created
  }
  return {
    all: <A>(table: string) => Effect.succeed(rows(table) as ReadonlyArray<A>),
    page: <A>(table: string, request: { offset: number; limit: number }) =>
      Effect.succeed({
        rows: rows(table).slice(request.offset, request.offset + request.limit) as ReadonlyArray<A>,
        total: rows(table).length,
        offset: request.offset,
        limit: request.limit,
        sortedBy: "createdAt",
      }),
    byId: <A>(table: string, id: string) => Effect.succeed(rows(table).find((row) => row.id === id) as A | undefined),
    insert: (table: string, type: string, prefix: string, values: Record<string, unknown>) =>
      Effect.sync(() => {
        const row = {
          id: `${prefix}-${++next}`,
          type,
          createdAt: new Date(Date.UTC(2026, 7, 14, 12, 0, next)).toISOString(),
          deleted: false,
          ...values,
        }
        rows(table).push(row)
        return row
      }),
    update: (table: string, id: string, patch: Record<string, unknown>) =>
      Effect.sync(() => {
        const row = rows(table).find((candidate) => candidate.id === id)
        if (!row) return undefined
        Object.assign(row, patch)
        return row
      }),
    count: (table: string) => Effect.succeed(rows(table).length),
  }
}

const tools = () => ({
  store: memoryStore(),
  bus: { publish: () => Effect.void },
  catalogue: () => [],
  permissions: () => new Map(),
  commands: () => [],
})

const ana = { userId: "ana", roles: ["reader"] }
const ref = { cube: "crm/contacts", entityType: "Contact", entityId: "contact-42" }

describe("permissions sharing capability", () => {
  it("gives a direct @username grant TOTAL access by default", async () => {
    const service = cube.create(tools()).entityPermissions
    assert.ok(service)
    await Effect.runPromise(service.claim(ana, ref))
    const grant = await Effect.runPromise(service.grantUser(ana, ref, "mihai"))
    assert.deepEqual(grant.actions, TotalActions)
    assert.deepEqual(await Effect.runPromise(service.listGrants(ana, ref)), [grant])
    assert.deepEqual(await Effect.runPromise(service.authorize({ userId: "mihai", roles: [] }, ref, "transfer")), {
      allowed: true,
      source: "grant",
    })
  })

  it("combines group membership with a custom READ grant", async () => {
    const service = cube.create(tools()).entityPermissions
    assert.ok(service)
    await Effect.runPromise(service.claim(ana, ref))
    const sales = await Effect.runPromise(service.createGroup(ana, ref.cube, "Sales"))
    await Effect.runPromise(service.addGroupMember(ana, sales.id, "ioana"))
    await Effect.runPromise(service.grantGroup(ana, ref, sales.id, ["read"]))
    assert.equal(
      (await Effect.runPromise(service.authorize({ userId: "ioana", roles: [] }, ref, "read"))).allowed,
      true,
    )
    assert.equal(
      (await Effect.runPromise(service.authorize({ userId: "ioana", roles: [] }, ref, "edit"))).allowed,
      false,
    )
  })

  it("refuses a group grant across cube boundaries", async () => {
    const service = cube.create(tools()).entityPermissions
    assert.ok(service)
    await Effect.runPromise(service.claim(ana, ref))
    const sales = await Effect.runPromise(
      service.createGroup({ userId: "root", roles: ["admin"] }, "crm/contracts", "Sales"),
    )
    await assert.rejects(Effect.runPromise(service.grantGroup(ana, ref, sales.id, ["read"])), /another cube/)
  })

  it("refuses membership changes from someone who did not create the group", async () => {
    const service = cube.create(tools()).entityPermissions
    assert.ok(service)
    await Effect.runPromise(service.claim(ana, ref))
    const sales = await Effect.runPromise(service.createGroup(ana, ref.cube, "Sales"))
    assert.ok(
      (await Effect.runPromise(
        Effect.flip(service.addGroupMember({ userId: "stranger", roles: [] }, sales.id, "ioana")),
      )) instanceof PermissionForbidden,
    )
  })

  it("rejects an empty grant action set as typed invalid input", async () => {
    const service = cube.create(tools()).entityPermissions
    assert.ok(service)
    await Effect.runPromise(service.claim(ana, ref))
    assert.ok(
      (await Effect.runPromise(Effect.flip(service.grantUser(ana, ref, "mihai", [])))) instanceof PermissionInvalid,
    )
  })

  it("stops a user grant from authorizing after revocation", async () => {
    const service = cube.create(tools()).entityPermissions
    assert.ok(service)
    await Effect.runPromise(service.claim(ana, ref))
    const grant = await Effect.runPromise(service.grantUser(ana, ref, "mihai", ["read"]))
    await Effect.runPromise(service.revokeGrant(ana, grant.id))
    assert.equal(
      (await Effect.runPromise(service.authorize({ userId: "mihai", roles: [] }, ref, "read"))).allowed,
      false,
    )
  })

  it("does not let a TOTAL grantee share the entity again", async () => {
    const service = cube.create(tools()).entityPermissions
    assert.ok(service)
    await Effect.runPromise(service.claim(ana, ref))
    await Effect.runPromise(service.grantUser(ana, ref, "mihai"))
    await assert.rejects(
      Effect.runPromise(service.grantUser({ userId: "mihai", roles: [] }, ref, "ioana")),
      /only owner, cube admin or superadmin/,
    )
  })

  it("records filterable grant audit with linked before/after trace", async () => {
    const service = cube.create(tools()).entityPermissions
    assert.ok(service)
    await Effect.runPromise(service.claim(ana, ref))
    const sales = await Effect.runPromise(service.createGroup(ana, ref.cube, "Sales"))
    await Effect.runPromise(service.grantGroup(ana, ref, sales.id, ["read"]))
    const events = await Effect.runPromise(
      service.audit({ actorUserId: "ana", groupId: sales.id, cube: "crm/contacts", action: "grant.group" }),
    )
    assert.equal(events.length, 1)
    assert.equal(events[0]?.result, "success")
    assert.equal(events[0]?.before, null)
    assert.deepEqual(events[0]?.after, { groupId: sales.id, actions: ["read"] })
    assert.ok(events[0]?.traceId)
  })

  it("matches a group audit filter against both before and after trace", async () => {
    const service = cube.create(tools()).entityPermissions
    assert.ok(service)
    await Effect.runPromise(service.claim(ana, ref))
    const sales = await Effect.runPromise(service.createGroup(ana, ref.cube, "Sales"))
    const grant = await Effect.runPromise(service.grantGroup(ana, ref, sales.id, ["read"]))
    await Effect.runPromise(service.revokeGrant(ana, grant.id))
    const events = await Effect.runPromise(service.audit({ groupId: sales.id }))
    assert.deepEqual(
      events.map((event) => event.action),
      ["grant.group", "grant.revoke"],
    )
  })

  it("uses current cube ownership instead of permanent group creator privilege", async () => {
    const service = cube.create(tools()).entityPermissions
    assert.ok(service)
    await Effect.runPromise(service.claim(ana, ref))
    const sales = await Effect.runPromise(service.createGroup(ana, ref.cube, "Sales"))
    await Effect.runPromise(service.transferOwnership(ana, ref, "mihai"))
    assert.ok(
      (await Effect.runPromise(Effect.flip(service.renameGroup(ana, sales.id, "Old owner edit")))) instanceof
        PermissionForbidden,
    )
    assert.equal(
      (await Effect.runPromise(service.renameGroup({ userId: "mihai", roles: [] }, sales.id, "Current owner edit")))
        .name,
      "Current owner edit",
    )
  })

  it("unites direct and every matching group grant in visibility provenance", async () => {
    const service = cube.create(tools()).entityPermissions
    assert.ok(service)
    await Effect.runPromise(service.claim(ana, ref))
    const sales = await Effect.runPromise(service.createGroup(ana, ref.cube, "Sales"))
    const legal = await Effect.runPromise(service.createGroup(ana, ref.cube, "Legal"))
    await Effect.runPromise(service.addGroupMember(ana, sales.id, "ioana"))
    await Effect.runPromise(service.addGroupMember(ana, legal.id, "ioana"))
    await Effect.runPromise(service.grantUser(ana, ref, "ioana", ["read"]))
    await Effect.runPromise(service.grantGroup(ana, ref, sales.id, ["edit"]))
    await Effect.runPromise(service.grantGroup(ana, ref, legal.id, ["delete", "read"]))
    const row = (await Effect.runPromise(service.listVisible({ userId: "ioana", roles: [] }, ref.cube, "all")))[0]
    assert.equal(row?.access.source, "user-grant")
    assert.deepEqual(row?.access.actions, ["read", "edit", "delete"])
  })
})
