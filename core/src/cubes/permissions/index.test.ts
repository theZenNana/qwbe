import assert from "node:assert/strict"
import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { PermissionConflict, PermissionForbidden, PermissionInvalid, PermissionNotFound } from "qwbe-core/permissions"
import { memoryStore } from "../../test-cube-tools.ts"
import { cube } from "./index.ts"

const tools = () => ({
  store: memoryStore(),
  bus: { publish: () => Effect.void },
  catalogue: () => [],
  permissions: () => new Map(),
  commands: () => [],
})

describe("permissions group members", () => {
  const setup = Effect.gen(function* () {
    const service = cube.create(tools()).entityPermissions
    assert.ok(service)
    const root = { userId: "root", roles: ["admin"] }
    const group = yield* service.createGroup(root, "crm", "sales")
    yield* service.addGroupMember(root, group.id, "ana")
    yield* service.addGroupMember(root, group.id, "mihai")
    return { service, root, groupId: group.id }
  })

  it.effect("lists active members for an authorized actor", () =>
    Effect.gen(function* () {
      const { service, groupId } = yield* setup
      const members = yield* service.groupMembers({ userId: "root", roles: ["admin"] }, groupId)
      assert.deepEqual(members.map((member) => member.userId).sort(), ["ana", "mihai"])
    }),
  )

  it.effect("excludes soft-deleted memberships", () =>
    Effect.gen(function* () {
      const { service, groupId } = yield* setup
      yield* service.removeGroupMember({ userId: "root", roles: ["admin"] }, groupId, "ana")
      const members = yield* service.groupMembers({ userId: "root", roles: ["admin"] }, groupId)
      assert.deepEqual(
        members.map((member) => member.userId),
        ["mihai"],
      )
    }),
  )

  it.effect("denies a user without authority over the group's cube", () =>
    Effect.gen(function* () {
      const { service, groupId } = yield* setup
      const failure = yield* Effect.flip(service.groupMembers({ userId: "stranger", roles: ["reader"] }, groupId))
      assert.ok(failure instanceof PermissionForbidden)
    }),
  )

  it.effect("denies an entity owner of a DIFFERENT cube (cross-cube)", () =>
    Effect.gen(function* () {
      const { service, groupId } = yield* setup
      const ref = { cube: "notes", entityType: "Note", entityId: "note-1" }
      yield* service.claim({ userId: "notes-owner", roles: ["reader"] }, ref)
      const failure = yield* Effect.flip(service.groupMembers({ userId: "notes-owner", roles: ["reader"] }, groupId))
      assert.ok(failure instanceof PermissionForbidden)
    }),
  )

  it.effect("returns a typed not-found for an unknown group", () =>
    Effect.gen(function* () {
      const { service } = yield* setup
      const failure = yield* Effect.flip(service.groupMembers({ userId: "root", roles: ["admin"] }, "grp-missing"))
      assert.ok(failure instanceof PermissionNotFound)
    }),
  )

  it.effect("allows a cube admin of the group's cube but not of another cube", () =>
    Effect.gen(function* () {
      const { service, groupId } = yield* setup
      yield* service.assignCubeAdmin({ userId: "root", roles: ["admin"] }, "crm", "cube-admin")
      const members = yield* service.groupMembers({ userId: "cube-admin", roles: ["reader"] }, groupId)
      assert.equal(members.length, 2)
      yield* service.assignCubeAdmin({ userId: "root", roles: ["admin"] }, "notes", "notes-admin")
      const failure = yield* Effect.flip(service.groupMembers({ userId: "notes-admin", roles: ["reader"] }, groupId))
      assert.ok(failure instanceof PermissionForbidden)
    }),
  )
})

describe("permissions public capability", () => {
  it.effect("records immutable creator and owner when an entity is claimed", () =>
    Effect.gen(function* () {
      const service = cube.create(tools()).entityPermissions
      assert.ok(service)
      const ref = { cube: "crm/contacts", entityType: "Contact", entityId: "contact-1" }
      const ownership = yield* service.claim({ userId: "ana", roles: ["reader"] }, ref)
      assert.equal(ownership.ownerId, "ana")
      assert.equal(ownership.createdBy, "ana")
      const conflict = yield* Effect.flip(service.claim({ userId: "mihai", roles: ["reader"] }, ref))
      assert.ok(conflict instanceof PermissionConflict)
      assert.equal(conflict._tag, "PermissionConflict")
      assert.match(conflict.message, /already claimed/)
    }),
  )

  it.effect("returns typed not-found and invalid failures through the public capability", () =>
    Effect.gen(function* () {
      const service = cube.create(tools()).entityPermissions
      assert.ok(service)
      const actor = { userId: "ana", roles: ["reader"] }
      const missing = { cube: "notes", entityType: "Note", entityId: "missing" }
      assert.ok((yield* Effect.flip(service.transferOwnership(actor, missing, "mihai"))) instanceof PermissionNotFound)
      assert.ok((yield* Effect.flip(service.createGroup(actor, "notes", "   "))) instanceof PermissionInvalid)
    }),
  )

  it.effect("authorizes superadmin, cube admin and owner but denies an unrelated user", () =>
    Effect.gen(function* () {
      const service = cube.create(tools()).entityPermissions
      assert.ok(service)
      const ref = { cube: "crm/contacts", entityType: "Contact", entityId: "contact-2" }
      yield* service.claim({ userId: "ana", roles: ["reader"] }, ref)
      yield* service.assignCubeAdmin({ userId: "root", roles: ["admin"] }, ref.cube, "cube-admin")
      assert.deepEqual(yield* service.authorize({ userId: "root", roles: ["admin"] }, ref, "delete"), {
        allowed: true,
        source: "superadmin",
      })
      assert.deepEqual(yield* service.authorize({ userId: "cube-admin", roles: ["reader"] }, ref, "edit"), {
        allowed: true,
        source: "cube-admin",
      })
      assert.deepEqual(yield* service.authorize({ userId: "ana", roles: ["reader"] }, ref, "read"), {
        allowed: true,
        source: "owner",
      })
      assert.deepEqual(yield* service.authorize({ userId: "stranger", roles: ["reader"] }, ref, "read"), {
        allowed: false,
        source: "none",
      })
    }),
  )

  it.effect("revokes a cube administrator and records the before/after audit", () =>
    Effect.gen(function* () {
      const service = cube.create(tools()).entityPermissions
      assert.ok(service)
      const root = { userId: "root", roles: ["admin"] }
      const ref = { cube: "notes", entityType: "Note", entityId: "note-admin" }
      yield* service.claim({ userId: "ana", roles: [] }, ref)
      yield* service.assignCubeAdmin(root, ref.cube, "cube-admin")
      yield* service.revokeCubeAdmin(root, ref.cube, "cube-admin")
      assert.deepEqual(yield* service.cubeAdmins(root, ref.cube), [])
      assert.equal((yield* service.authorize({ userId: "cube-admin", roles: [] }, ref, "edit")).allowed, false)
      const events = yield* service.audit({ action: "cube-admin.revoke" })
      assert.equal(events.length, 1)
      const first = events[0] as { before?: { userId?: string }; after?: unknown }
      assert.equal(first.before?.userId, "cube-admin")
      assert.equal(first.after, null)
    }),
  )

  it.effect("writes filterable audit events with before and after trace", () =>
    Effect.gen(function* () {
      const service = cube.create(tools()).entityPermissions
      assert.ok(service)
      const ref = { cube: "notes", entityType: "Note", entityId: "note-1" }
      yield* service.claim({ userId: "ana", roles: ["reader"] }, ref)
      yield* service.authorize({ userId: "mihai", roles: ["reader"] }, ref, "read")
      const denied = yield* service.audit({ result: "denied", actorUserId: "mihai" })
      assert.equal(denied.length, 1)
      assert.equal(denied[0]?.action, "entity.read")
      assert.equal(denied[0]?.before, null)
      assert.deepEqual(denied[0]?.after, { allowed: false, source: "none" })
      assert.ok(denied[0]?.traceId)
    }),
  )

  it.effect("transfers ownership without changing the immutable creator", () =>
    Effect.gen(function* () {
      const service = cube.create(tools()).entityPermissions
      assert.ok(service)
      const actor = { userId: "ana", roles: ["reader"] }
      const ref = { cube: "notes", entityType: "Note", entityId: "note-transfer" }
      yield* service.claim(actor, ref)
      const changed = yield* service.transferOwnership(actor, ref, "mihai")
      assert.equal(changed.ownerId, "mihai")
      assert.equal(changed.createdBy, "ana")
      assert.equal((yield* service.ownership(ref))?.ownerId, "mihai")
    }),
  )

  it.effect("hides only from the actor normal list and restores the entity on Unhide", () =>
    Effect.gen(function* () {
      const service = cube.create(tools()).entityPermissions
      assert.ok(service)
      const actor = { userId: "ana", roles: ["reader"] }
      const ref = { cube: "crm/contacts", entityType: "Contact", entityId: "contact-hidden" }
      yield* service.claim(actor, ref)

      assert.equal((yield* service.listVisible(actor, ref.cube, "all")).length, 1)
      yield* service.setHidden(actor, ref, true)
      assert.equal((yield* service.listVisible(actor, ref.cube, "all")).length, 0)
      assert.equal((yield* service.listVisible(actor, ref.cube, "hidden-by-me")).length, 1)

      yield* service.setHidden(actor, ref, false)
      assert.equal((yield* service.listVisible(actor, ref.cube, "all")).length, 1)
      assert.equal((yield* service.listVisible(actor, ref.cube, "hidden-by-me")).length, 0)
    }),
  )

  it.effect("audits observed visibility before and after an idempotent Hide", () =>
    Effect.gen(function* () {
      const service = cube.create(tools()).entityPermissions
      assert.ok(service)
      const actor = { userId: "ana", roles: ["reader"] }
      const ref = { cube: "crm/contracts", entityType: "Contract", entityId: "contract-hidden" }
      yield* service.claim(actor, ref)
      yield* service.setHidden(actor, ref, true)
      yield* service.setHidden(actor, ref, true)

      const audit = yield* service.audit({ actorUserId: actor.userId, action: "visibility.hide" })
      assert.deepEqual(
        audit.map(({ before, after }) => ({ before, after })),
        [
          { before: { hidden: false }, after: { hidden: true } },
          { before: { hidden: true }, after: { hidden: true } },
        ],
      )
    }),
  )
})
