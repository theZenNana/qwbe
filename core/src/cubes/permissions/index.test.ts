import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Effect } from "effect"
import type { CubeTools } from "qwbe-core/cube"
import { PermissionConflict, PermissionForbidden, PermissionInvalid, PermissionNotFound } from "qwbe-core/permissions"
import { cube } from "./index.ts"

const memoryStore = (): CubeTools["store"] => {
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
    page: <A>(table: string, page: { offset: number; limit: number }, where?: unknown) => {
      // One-pair filter only: what the permissions state's `every` reads through.
      const pair = where as { field: string; value: unknown } | undefined
      const hit = pair && "field" in pair ? rows(table).filter((row) => row[pair.field] === pair.value) : rows(table)
      return Effect.succeed({
        rows: hit.slice(page.offset, page.offset + page.limit) as ReadonlyArray<A>,
        total: hit.length,
        offset: page.offset,
        limit: page.limit,
        sortedBy: "createdAt",
      })
    },
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

describe("permissions group members", () => {
  const setup = async () => {
    const service = cube.create(tools()).entityPermissions
    assert.ok(service)
    const root = { userId: "root", roles: ["admin"] }
    const group = await Effect.runPromise(service.createGroup(root, "crm", "sales"))
    await Effect.runPromise(service.addGroupMember(root, group.id, "ana"))
    await Effect.runPromise(service.addGroupMember(root, group.id, "mihai"))
    return { service, root, groupId: group.id }
  }

  it("lists active members for an authorized actor", async () => {
    const { service, groupId } = await setup()
    const members = await Effect.runPromise(service.groupMembers({ userId: "root", roles: ["admin"] }, groupId))
    assert.deepEqual(members.map((member) => member.userId).sort(), ["ana", "mihai"])
  })

  it("excludes soft-deleted memberships", async () => {
    const { service, groupId } = await setup()
    await Effect.runPromise(service.removeGroupMember({ userId: "root", roles: ["admin"] }, groupId, "ana"))
    const members = await Effect.runPromise(service.groupMembers({ userId: "root", roles: ["admin"] }, groupId))
    assert.deepEqual(
      members.map((member) => member.userId),
      ["mihai"],
    )
  })

  it("denies a user without authority over the group's cube", async () => {
    const { service, groupId } = await setup()
    const failure = await Effect.runPromise(
      Effect.flip(service.groupMembers({ userId: "stranger", roles: ["reader"] }, groupId)),
    )
    assert.ok(failure instanceof PermissionForbidden)
  })

  it("denies an entity owner of a DIFFERENT cube (cross-cube)", async () => {
    const { service, groupId } = await setup()
    const ref = { cube: "notes", entityType: "Note", entityId: "note-1" }
    await Effect.runPromise(service.claim({ userId: "notes-owner", roles: ["reader"] }, ref))
    const failure = await Effect.runPromise(
      Effect.flip(service.groupMembers({ userId: "notes-owner", roles: ["reader"] }, groupId)),
    )
    assert.ok(failure instanceof PermissionForbidden)
  })

  it("returns a typed not-found for an unknown group", async () => {
    const { service } = await setup()
    const failure = await Effect.runPromise(
      Effect.flip(service.groupMembers({ userId: "root", roles: ["admin"] }, "grp-missing")),
    )
    assert.ok(failure instanceof PermissionNotFound)
  })

  it("allows a cube admin of the group's cube but not of another cube", async () => {
    const { service, groupId } = await setup()
    await Effect.runPromise(service.assignCubeAdmin({ userId: "root", roles: ["admin"] }, "crm", "cube-admin"))
    const members = await Effect.runPromise(service.groupMembers({ userId: "cube-admin", roles: ["reader"] }, groupId))
    assert.equal(members.length, 2)
    await Effect.runPromise(service.assignCubeAdmin({ userId: "root", roles: ["admin"] }, "notes", "notes-admin"))
    const failure = await Effect.runPromise(
      Effect.flip(service.groupMembers({ userId: "notes-admin", roles: ["reader"] }, groupId)),
    )
    assert.ok(failure instanceof PermissionForbidden)
  })
})

describe("permissions public capability", () => {
  it("records immutable creator and owner when an entity is claimed", async () => {
    const service = cube.create(tools()).entityPermissions
    assert.ok(service)
    const ref = { cube: "crm/contacts", entityType: "Contact", entityId: "contact-1" }
    const ownership = await Effect.runPromise(service.claim({ userId: "ana", roles: ["reader"] }, ref))
    assert.equal(ownership.ownerId, "ana")
    assert.equal(ownership.createdBy, "ana")
    const conflict = await Effect.runPromise(Effect.flip(service.claim({ userId: "mihai", roles: ["reader"] }, ref)))
    assert.ok(conflict instanceof PermissionConflict)
    assert.equal(conflict._tag, "PermissionConflict")
    assert.match(conflict.message, /already claimed/)
  })

  it("returns typed not-found and invalid failures through the public capability", async () => {
    const service = cube.create(tools()).entityPermissions
    assert.ok(service)
    const actor = { userId: "ana", roles: ["reader"] }
    const missing = { cube: "notes", entityType: "Note", entityId: "missing" }
    assert.ok(
      (await Effect.runPromise(Effect.flip(service.transferOwnership(actor, missing, "mihai")))) instanceof
        PermissionNotFound,
    )
    assert.ok(
      (await Effect.runPromise(Effect.flip(service.createGroup(actor, "notes", "   ")))) instanceof PermissionInvalid,
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

  it("revokes a cube administrator and records the before/after audit", async () => {
    const service = cube.create(tools()).entityPermissions
    assert.ok(service)
    const root = { userId: "root", roles: ["admin"] }
    const ref = { cube: "notes", entityType: "Note", entityId: "note-admin" }
    await Effect.runPromise(service.claim({ userId: "ana", roles: [] }, ref))
    await Effect.runPromise(service.assignCubeAdmin(root, ref.cube, "cube-admin"))
    await Effect.runPromise(service.revokeCubeAdmin(root, ref.cube, "cube-admin"))
    assert.deepEqual(await Effect.runPromise(service.cubeAdmins(root, ref.cube)), [])
    assert.equal(
      (await Effect.runPromise(service.authorize({ userId: "cube-admin", roles: [] }, ref, "edit"))).allowed,
      false,
    )
    const events = await Effect.runPromise(service.audit({ action: "cube-admin.revoke" }))
    assert.equal(events.length, 1)
    const first = events[0] as { before?: { userId?: string }; after?: unknown }
    assert.equal(first.before?.userId, "cube-admin")
    assert.equal(first.after, null)
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
