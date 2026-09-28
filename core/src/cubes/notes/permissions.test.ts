import assert from "node:assert/strict"
import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { CurrentUser } from "qwbe-core/auth"
import type { CubeTools } from "qwbe-core/cube"
import type { PageRequest } from "qwbe-core/pagination"
import type { Ownership, PermissionService } from "qwbe-core/permissions"
import { enforceEntityHandlers } from "../../entity-enforcement.ts"
import type { ListWhere } from "../../kernel/pagination.ts"
import { cube } from "./index.ts"
import { LEGACY_UNOWNED, migrateLegacyNotes } from "./permissions.ts"

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
})

describe("notes list -- one SQL page, permissions left to the entity wrapper (Qwbe#73)", () => {
  type ListHandler = (
    request: unknown,
  ) => Effect.Effect<{ rows: ReadonlyArray<{ id: string }>; total: number }, unknown, CurrentUser>
  const rows = [note("note-1", "ana"), note("note-2", "bob"), note("note-3", "ana")]
  // Pages like Postgres does for `ids`: empty or absent means every row.
  const pagingStore = (asked: Array<unknown> = []) => ({
    page: (table: string, request: PageRequest, where?: ListWhere) =>
      Effect.sync(() => {
        asked.push([table, request, where])
        const matching = where?.ids?.length ? rows.filter((row) => where.ids?.includes(row.id)) : rows
        return {
          rows: matching.slice(request.offset, request.offset + request.limit),
          total: matching.length,
          offset: request.offset,
          limit: request.limit,
          sortedBy: request.sortBy ?? "createdAt",
        }
      }),
  })
  const parts = (store: unknown) =>
    cube.create({ store, bus: { publish: () => Effect.void }, entityPermissions: {} } as never) as unknown as {
      group: Parameters<typeof enforceEntityHandlers>[2]
      handlers: { list: ListHandler }
    }
  const user = { id: "ana", username: "ana", roles: ["reader"], permissions: ["notes:read"], sessionId: "s" }

  it.effect("hands ids, paging and sort to store.page and returns its page", () =>
    Effect.gen(function* () {
      const asked: Array<unknown> = []
      const page = yield* parts(pagingStore(asked))
        .handlers.list({ urlParams: { offset: 1, limit: 1, sortBy: "title", descending: true, ids: "note-1,note-3" } })
        .pipe(Effect.provideService(CurrentUser, user))
      assert.deepEqual(
        page.rows.map((row) => row.id),
        ["note-3"],
      )
      assert.equal(page.total, 2)
      assert.deepEqual(asked, [
        ["notes", { offset: 1, limit: 1, sortBy: "title", descending: true }, { ids: ["note-1", "note-3"] }],
      ])
    }),
  )

  it.effect("through the entity wrapper: one authorizeList, one audit row, only visible notes", () =>
    Effect.gen(function* () {
      const calls: Array<string> = []
      const audits: Array<ReadonlyArray<string>> = []
      const permissions = {
        authorize: () => Effect.die("a list must not authorize per note"),
        authorizeList: () =>
          Effect.sync(() => {
            calls.push("authorizeList")
            return new Set(["note-1", "note-3"])
          }),
        auditList: (_actor: unknown, _scope: unknown, _action: unknown, _source: unknown, ids: ReadonlyArray<string>) =>
          Effect.sync(() => {
            audits.push(ids)
          }),
      } as unknown as PermissionService
      const { group, handlers } = parts(pagingStore())
      const wrapped = enforceEntityHandlers("notes", "Note", group, handlers, permissions)
      const page = yield* wrapped
        .list({ urlParams: { offset: 0, limit: 10, descending: false } })
        .pipe(Effect.provideService(CurrentUser, user))
      assert.deepEqual(
        page.rows.map((row) => row.id),
        ["note-1", "note-3"],
      )
      assert.deepEqual(calls, ["authorizeList"])
      assert.deepEqual(audits, [["note-1", "note-3"]])
    }),
  )
})
