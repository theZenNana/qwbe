import assert from "node:assert/strict"
import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { EntityVisibility } from "qwbe-core/permissions"
import { memoryStore } from "../../test-cube-tools.ts"
import { cube } from "./index.ts"

const tools = () => ({
  store: memoryStore(),
  bus: { publish: () => Effect.void },
  catalogue: () => [],
  permissions: () => new Map(),
  commands: () => [],
})

describe("permissions listVisible in bulk", () => {
  it.effect("matches the single-entity visibility for every actor and row", () =>
    Effect.gen(function* () {
      const service = cube.create(tools()).entityPermissions
      assert.ok(service)
      const root = { userId: "root", roles: ["admin"] }
      const ana = { userId: "ana", roles: [] }
      const ioana = { userId: "ioana", roles: [] }
      const mihai = { userId: "mihai", roles: [] }
      const boss = { userId: "boss", roles: [] }
      const stranger = { userId: "stranger", roles: [] }
      const at = (entityId: string) => ({ cube: "crm/contacts", entityType: "Contact", entityId })
      const other = { cube: "crm/deals", entityType: "Deal", entityId: "d-1" }

      yield* service.assignCubeAdmin(root, "crm/contacts", "boss")
      for (const id of ["c-1", "c-2", "c-3"]) yield* service.claim(ana, at(id))
      yield* service.claim(boss, at("c-4"))
      yield* service.transferOwnership(boss, at("c-4"), "ana")
      yield* service.claim(ana, other)
      const sales = yield* service.createGroup(ana, "crm/contacts", "Sales")
      yield* service.addGroupMember(ana, sales.id, "ioana")
      yield* service.grantGroup(ana, at("c-1"), sales.id, ["read"])
      yield* service.grantGroup(ana, at("c-2"), sales.id, ["read"])
      yield* service.grantUser(ana, at("c-2"), "ioana", ["edit"])
      yield* service.grantUser(ana, at("c-3"), "mihai")
      yield* service.setHidden(ioana, at("c-2"), true)
      yield* service.setHidden(ana, at("c-3"), true)

      const sources: Record<string, Array<string>> = {}
      for (const actor of [root, ana, ioana, mihai, boss, stranger]) {
        const rows: Array<EntityVisibility> = [
          ...(yield* service.listVisible(actor, "crm/contacts", "all")),
          ...(yield* service.listVisible(actor, "crm/contacts", "hidden-by-me")),
        ]
        for (const row of rows) assert.deepEqual(row, yield* service.setHidden(actor, row, row.hidden))
        sources[actor.userId] = rows.map((row) => `${row.entityId}:${row.access.source}:${row.hidden}`)
      }
      assert.deepEqual(sources, {
        root: ["c-1:superadmin:false", "c-2:superadmin:false", "c-3:superadmin:false", "c-4:superadmin:false"],
        ana: ["c-1:owner:false", "c-2:owner:false", "c-4:owner:false", "c-3:owner:true"],
        ioana: ["c-1:group-grant:false", "c-2:user-grant:true"],
        mihai: ["c-3:user-grant:false"],
        boss: ["c-1:cube-admin:false", "c-2:cube-admin:false", "c-3:cube-admin:false", "c-4:creator:false"],
        stranger: [],
      })
    }),
  )
})
