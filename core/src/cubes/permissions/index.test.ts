import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Effect } from "effect"
import type { CubeStore } from "../../kernel/manifest.ts"
import { cube } from "./index.ts"

const memoryStore = (): CubeStore => {
  const tables = new Map<string, Array<Record<string, unknown>>>()
  let next = 0
  const rows = (table: string) => {
    const found = tables.get(table)
    if (found) return found
    const created: Array<Record<string, unknown>> = []
    tables.set(table, created)
    return created
  }
  return {
    all: <A>(table: string) => Effect.succeed(rows(table) as ReadonlyArray<A>),
    page: <A>(table: string, page: { offset: number; limit: number }) =>
      Effect.succeed({
        rows: rows(table).slice(page.offset, page.offset + page.limit) as ReadonlyArray<A>,
        total: rows(table).length,
        offset: page.offset,
        limit: page.limit,
        sortedBy: "createdAt",
      }),
    byId: <A>(table: string, id: string) => Effect.succeed(rows(table).find((row) => row.id === id) as A | undefined),
    insert: (table: string, type: string, prefix: string, values: Record<string, unknown>) =>
      Effect.sync(() => {
        const row = { id: `${prefix}-${++next}`, type, createdAt: new Date().toISOString(), deleted: false, ...values }
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

describe("permissions public capability", () => {
  it("records immutable creator and owner when an entity is claimed", async () => {
    const service = cube.create(tools()).entityPermissions
    assert.ok(service)
    const ref = { cube: "crm/contacts", entityType: "Contact", entityId: "contact-1" }
    const ownership = await Effect.runPromise(service.claim({ userId: "ana", roles: ["reader"] }, ref))
    assert.equal(ownership.ownerId, "ana")
    assert.equal(ownership.createdBy, "ana")
    await assert.rejects(
      Effect.runPromise(service.claim({ userId: "mihai", roles: ["reader"] }, ref)),
      /already claimed/,
    )
  })

  it("authorizes superadmin, cube admin and owner but denies an unrelated user", async () => {
    const service = cube.create(tools()).entityPermissions
    assert.ok(service)
    const ref = { cube: "crm/contacts", entityType: "Contact", entityId: "contact-2" }
    await Effect.runPromise(service.claim({ userId: "ana", roles: ["reader"] }, ref))
    await Effect.runPromise(service.assignCubeAdmin({ userId: "root", roles: ["admin"] }, ref.cube, "cube-admin"))
    assert.deepEqual(await Effect.runPromise(service.authorize({ userId: "root", roles: ["admin"] }, ref, "delete")), {
      allowed: true,
      source: "superadmin",
    })
    assert.deepEqual(
      await Effect.runPromise(service.authorize({ userId: "cube-admin", roles: ["reader"] }, ref, "edit")),
      { allowed: true, source: "cube-admin" },
    )
    assert.deepEqual(await Effect.runPromise(service.authorize({ userId: "ana", roles: ["reader"] }, ref, "read")), {
      allowed: true,
      source: "owner",
    })
    assert.deepEqual(
      await Effect.runPromise(service.authorize({ userId: "stranger", roles: ["reader"] }, ref, "read")),
      { allowed: false, source: "none" },
    )
  })

  it("writes filterable audit events with before and after trace", async () => {
    const service = cube.create(tools()).entityPermissions
    assert.ok(service)
    const ref = { cube: "notes", entityType: "Note", entityId: "note-1" }
    await Effect.runPromise(service.claim({ userId: "ana", roles: ["reader"] }, ref))
    await Effect.runPromise(service.authorize({ userId: "mihai", roles: ["reader"] }, ref, "read"))
    const denied = await Effect.runPromise(service.audit({ result: "denied", actorUserId: "mihai" }))
    assert.equal(denied.length, 1)
    assert.equal(denied[0]?.action, "entity.read")
    assert.equal(denied[0]?.before, null)
    assert.deepEqual(denied[0]?.after, { allowed: false, source: "none" })
    assert.ok(denied[0]?.traceId)
  })

  it("transfers ownership without changing the immutable creator", async () => {
    const service = cube.create(tools()).entityPermissions
    assert.ok(service)
    const actor = { userId: "ana", roles: ["reader"] }
    const ref = { cube: "notes", entityType: "Note", entityId: "note-transfer" }
    await Effect.runPromise(service.claim(actor, ref))
    const changed = await Effect.runPromise(service.transferOwnership(actor, ref, "mihai"))
    assert.equal(changed.ownerId, "mihai")
    assert.equal(changed.createdBy, "ana")
    assert.equal((await Effect.runPromise(service.ownership(ref)))?.ownerId, "mihai")
  })

  it("hides only from the actor normal list and restores the entity on Unhide", async () => {
    const service = cube.create(tools()).entityPermissions
    assert.ok(service)
    const actor = { userId: "ana", roles: ["reader"] }
    const ref = { cube: "crm/contacts", entityType: "Contact", entityId: "contact-hidden" }
    await Effect.runPromise(service.claim(actor, ref))

    assert.equal((await Effect.runPromise(service.listVisible(actor, ref.cube, "all"))).length, 1)
    await Effect.runPromise(service.setHidden(actor, ref, true))
    assert.equal((await Effect.runPromise(service.listVisible(actor, ref.cube, "all"))).length, 0)
    assert.equal((await Effect.runPromise(service.listVisible(actor, ref.cube, "hidden-by-me"))).length, 1)

    await Effect.runPromise(service.setHidden(actor, ref, false))
    assert.equal((await Effect.runPromise(service.listVisible(actor, ref.cube, "all"))).length, 1)
    assert.equal((await Effect.runPromise(service.listVisible(actor, ref.cube, "hidden-by-me"))).length, 0)
  })

  it("audits observed visibility before and after an idempotent Hide", async () => {
    const service = cube.create(tools()).entityPermissions
    assert.ok(service)
    const actor = { userId: "ana", roles: ["reader"] }
    const ref = { cube: "crm/contracts", entityType: "Contract", entityId: "contract-hidden" }
    await Effect.runPromise(service.claim(actor, ref))
    await Effect.runPromise(service.setHidden(actor, ref, true))
    await Effect.runPromise(service.setHidden(actor, ref, true))

    const audit = await Effect.runPromise(service.audit({ actorUserId: actor.userId, action: "visibility.hide" }))
    assert.deepEqual(
      audit.map(({ before, after }) => ({ before, after })),
      [
        { before: { hidden: false }, after: { hidden: true } },
        { before: { hidden: true }, after: { hidden: true } },
      ],
    )
  })
})
