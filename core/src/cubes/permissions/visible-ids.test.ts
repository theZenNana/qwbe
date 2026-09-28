import assert from "node:assert/strict"
import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { TotalActions } from "qwbe-core/permissions"
import { memoryStore } from "../../test-cube-tools.ts"
import { foundationFrom } from "./foundation.ts"
import { serviceFrom } from "./service.ts"
import { stateFrom, tables } from "./state.ts"

const scope = { cube: "crm/contacts", entityType: "Contact" }
const ref = (entityId: string) => ({ ...scope, entityId })
const user = (userId: string) => ({ userId, roles: [] })
const root = { userId: "root", roles: ["admin"] }
const ana = user("ana")
const bob = user("bob")
const mihai = user("mihai")
const ioana = user("ioana")
const dan = user("dan")
const cubeAdmin = user("cadmin")
const stranger = user("stranger")
const ids = ["owned", "user-grant", "group-grant", "edit-grant", "revoked", "unowned", "duplicate"]

describe("permissions visibleIds", () => {
  it.effect("equals decide for every actor and action", () =>
    Effect.gen(function* () {
      const store = memoryStore()
      const service = serviceFrom(store, () => new Map())
      const foundation = foundationFrom(stateFrom(store))
      yield* service.claim(ana, ref("owned"))
      for (const id of ["user-grant", "group-grant", "edit-grant", "revoked", "duplicate"])
        yield* service.claim(bob, ref(id))
      yield* service.grantUser(bob, ref("user-grant"), mihai.userId, ["read"])
      const sales = yield* service.createGroup(bob, scope.cube, "Sales")
      yield* service.addGroupMember(bob, sales.id, ioana.userId)
      yield* service.addGroupMember(bob, sales.id, dan.userId)
      yield* service.removeGroupMember(bob, sales.id, dan.userId)
      yield* service.grantGroup(bob, ref("group-grant"), sales.id, ["read"])
      yield* service.grantUser(bob, ref("edit-grant"), mihai.userId, ["edit"])
      const revoked = yield* service.grantUser(bob, ref("revoked"), mihai.userId, ["read"])
      yield* service.revokeGrant(bob, revoked.id)
      // A racing second claim: a newer ownership row for an entity bob already owns.
      yield* store.insert(tables.ownership, "Ownership", "own", { ...ref("duplicate"), ownerId: ana.userId })
      // Out of scope: another entity type must never leak into the set.
      yield* service.claim(ana, { ...scope, entityType: "Company", entityId: "elsewhere" })
      yield* service.assignCubeAdmin(root, scope.cube, cubeAdmin.userId)

      for (const actor of [ana, bob, mihai, ioana, dan, cubeAdmin, stranger, root])
        for (const action of TotalActions) {
          const decisions = yield* Effect.forEach(ids, (id) => foundation.decide(actor, ref(id), action))
          const expected = decisions.some((d) => d.source === "superadmin" || d.source === "cube-admin")
            ? "all"
            : new Set(ids.filter((_, i) => decisions[i]?.allowed))
          assert.deepEqual(yield* foundation.visibleIds(actor, scope, action), expected, `${actor.userId} ${action}`)
        }
      // The fixture really exercises the edge cases.
      assert.deepEqual(yield* foundation.visibleIds(ana, scope, "read"), new Set(["owned"]))
      assert.deepEqual(yield* foundation.visibleIds(mihai, scope, "read"), new Set(["user-grant"]))
      assert.deepEqual(yield* foundation.visibleIds(mihai, scope, "edit"), new Set(["edit-grant"]))
      assert.deepEqual(yield* foundation.visibleIds(ioana, scope, "read"), new Set(["group-grant"]))
      assert.deepEqual(yield* foundation.visibleIds(dan, scope, "read"), new Set())
      assert.equal(yield* foundation.visibleIds(cubeAdmin, scope, "read"), "all")
    }),
  )
})
