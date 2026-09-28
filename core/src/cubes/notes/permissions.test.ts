import assert from "node:assert/strict"
import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { CurrentUser } from "qwbe-core/auth"
import type { CubeTools } from "qwbe-core/cube"
import type { Ownership, PermissionService } from "qwbe-core/permissions"
import { LEGACY_UNOWNED, migrateLegacyNotes, visibleNotesPage } from "./permissions.ts"

const note = (id: string, authorId: string | null) => ({ id, authorId, deleted: false })

describe("notes ownership migration", () => {
  it.effect("deterministically migrates authors and null legacy owners once", () =>
    Effect.gen(function* () {
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

      assert.equal(yield* migrateLegacyNotes(store, permissions), 2)
      assert.equal(ownership.get("note-1")?.ownerId, "ana")
      assert.equal(ownership.get("note-2")?.ownerId, LEGACY_UNOWNED)
      assert.equal(yield* migrateLegacyNotes(store, permissions), 0)
    }),
  )

  it.effect("lists notes without claiming ownership inside the request", () =>
    Effect.gen(function* () {
      const rows = [note("note-1", "ana")]
      const store = { all: () => Effect.succeed(rows) } as Pick<CubeTools["store"], "all"> as CubeTools["store"]
      let reads = 0
      const permissions = {
        ownership: () =>
          Effect.sync(() => {
            reads += 1
          }),
        claim: () => Effect.die("claim inside a request"),
        authorize: () => Effect.sync(() => ({ allowed: true, reason: "owner" })),
      } as unknown as PermissionService
      const user = { id: "ana", roles: [] } as unknown as typeof CurrentUser.Service

      const page = yield* visibleNotesPage(store, permissions, user, { offset: 0, limit: 10, descending: false })

      assert.equal(page.total, 1)
      assert.equal(reads, 0)
    }),
  )
})
