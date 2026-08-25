import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Effect } from "effect"
import type { CubeTools } from "qwbe-core/cube"
import type { Ownership } from "qwbe-core/permissions"
import { LEGACY_UNOWNED, migrateLegacyNotes } from "./permissions.ts"

const note = (id: string, authorId: string | null) => ({ id, authorId, deleted: false })

describe("notes ownership migration", () => {
  it("deterministically migrates authors and null legacy owners once", async () => {
    const rows = [note("note-1", "ana"), note("note-2", null)]
    const ownership = new Map<string, Ownership>()
    const store = { all: () => Effect.succeed(rows) } as Pick<CubeTools["store"], "all"> as CubeTools["store"]
    const permissions = {
      ownership: (ref: { entityId: string }) => Effect.succeed(ownership.get(ref.entityId)),
      claim: (actor: { userId: string }, ref: { cube: string; entityType: string; entityId: string }) =>
        Effect.sync(() => {
          const value = {
            ...ref,
            ownerId: actor.userId,
            createdBy: actor.userId,
            createdAt: "2026-08-15T00:00:00.000Z",
          }
          ownership.set(ref.entityId, value)
          return value
        }),
    }

    assert.equal(await Effect.runPromise(migrateLegacyNotes(store, permissions)), 2)
    assert.equal(ownership.get("note-1")?.ownerId, "ana")
    assert.equal(ownership.get("note-2")?.ownerId, LEGACY_UNOWNED)
    assert.equal(await Effect.runPromise(migrateLegacyNotes(store, permissions)), 0)
  })
})
