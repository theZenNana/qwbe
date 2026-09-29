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

describe("notes item and search -- one permission check each (Qwbe#73)", () => {
  const full = (id: string, authorId: string) => ({
    ...note(id, authorId),
    title: id,
    body: "",
    createdAt: "2026-09-28",
  })
  const rows = [full("note-1", "ana"), full("note-2", "bob"), full("note-3", "ana")]
  const user = { id: "ana", username: "ana", roles: ["reader"], permissions: ["notes:read"], sessionId: "s" }
  const perNote = (what: string) => () => Effect.die(`search must not ${what} per note`)

  it.effect("a single read through the entity wrapper authorizes once, so one audit row", () =>
    Effect.gen(function* () {
      const authorized: Array<string> = []
      const permissions = {
        authorize: (_actor: unknown, ref: { entityId: string }) =>
          Effect.sync(() => {
            authorized.push(ref.entityId)
            return { allowed: true }
          }),
      } as unknown as PermissionService
      const store = { byId: (_table: string, id: string) => Effect.succeed(rows.find((row) => row.id === id)) }
      const parts = cube.create({ store, bus: {}, entityPermissions: permissions } as never) as unknown as {
        group: Parameters<typeof enforceEntityHandlers>[2]
        handlers: { get: (request: unknown) => Effect.Effect<{ id: string }, unknown, CurrentUser> }
      }
      const wrapped = enforceEntityHandlers("notes", "Note", parts.group, parts.handlers, permissions)
      const n = yield* wrapped.get({ path: { id: "note-3" } }).pipe(Effect.provideService(CurrentUser, user))
      assert.equal(n.id, "note-3")
      assert.deepEqual(authorized, ["note-3"])
    }),
  )

  it.effect("search: one authorizeList, the set filtered in SQL, one auditList, no claim", () =>
    Effect.gen(function* () {
      const asked: Array<unknown> = []
      const audits: Array<ReadonlyArray<string>> = []
      const permissions = {
        authorize: perNote("authorize"),
        claim: perNote("claim"),
        ownership: perNote("read ownership"),
        authorizeList: () => Effect.succeed(new Set(["note-1", "note-3"])),
        auditList: (_a: unknown, _s: unknown, _x: unknown, source: string, ids: ReadonlyArray<string>) =>
          Effect.sync(() => {
            audits.push([source, ...ids])
          }),
      } as unknown as PermissionService
      const store = {
        page: (_table: string, request: PageRequest, where: ListWhere) =>
          Effect.sync(() => {
            asked.push(where)
            const matching = rows.filter(
              (row) => row.authorId === where.equals?.[0]?.value && where.ids?.includes(row.id),
            )
            return { rows: matching.slice(request.offset, request.offset + request.limit), total: matching.length }
          }),
      }
      const parts = cube.create({ store, bus: {}, entityPermissions: permissions } as never)
      const result = yield* parts.relational!.search!("authorId", "ana", { offset: 0, limit: 10 }).pipe(
        Effect.provideService(CurrentUser, user),
      )
      assert.deepEqual(
        result.rows.map((row) => row.id),
        ["note-1", "note-3"],
      )
      assert.equal(result.total, 2)
      assert.deepEqual(asked, [{ equals: [{ field: "authorId", value: "ana" }], ids: ["note-1", "note-3"] }])
      assert.deepEqual(audits, [["scoped", "note-1", "note-3"]])
    }),
  )

  it.effect("search: an actor who sees no note gets an empty result without reaching the store", () =>
    Effect.gen(function* () {
      const audits: Array<ReadonlyArray<string>> = []
      const permissions = {
        authorizeList: () => Effect.succeed(new Set<string>()),
        auditList: (_a: unknown, _s: unknown, _x: unknown, _source: unknown, ids: ReadonlyArray<string>) =>
          Effect.sync(() => {
            audits.push(ids)
          }),
      } as unknown as PermissionService
      const store = { page: () => Effect.die("store must not be asked with an empty id set") }
      const parts = cube.create({ store, bus: {}, entityPermissions: permissions } as never)
      const result = yield* parts.relational!.search!("authorId", "ana", { offset: 0, limit: 10 }).pipe(
        Effect.provideService(CurrentUser, user),
      )
      assert.deepEqual(result, { rows: [], total: 0 })
      assert.deepEqual(audits, [[]])
    }),
  )
})
