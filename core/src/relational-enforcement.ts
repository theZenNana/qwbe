import { Effect } from "effect"
import { CurrentUser } from "./kernel/auth-contract.ts"
import type { RelationalPart, SearchResult } from "./kernel/manifest.ts"
import type { PageRequest } from "./kernel/pagination.ts"
import type { RowState } from "./kernel/store.ts"
import type { AccessDecision, EntityRef, PermissionActor } from "./permissions-contracts.ts"
import type { ListScope, ListSource } from "./permissions-service.ts"

export type RelationalGate = Readonly<{
  authorize: (actor: PermissionActor, ref: EntityRef, action: "read") => Effect.Effect<AccessDecision, unknown>
  authorizeList: (
    actor: PermissionActor,
    scope: ListScope,
    action: "read",
  ) => Effect.Effect<"all" | ReadonlySet<string>, unknown>
  auditList: (
    actor: PermissionActor,
    scope: ListScope,
    action: "read",
    source: ListSource,
    returnedIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, unknown>
}>
export type ProtectedRelationalEntry = Readonly<{
  name: string
  entity?: string | undefined
  relational?: RelationalPart | undefined
  permissionExempt?: boolean | undefined
  captureEntity?: string | undefined
  state?: ((id: string) => Effect.Effect<RowState | undefined>) | undefined
}>

const actor = (user: typeof CurrentUser.Service): PermissionActor => ({ userId: user.id, roles: user.roles })
const allowed = (
  gate: RelationalGate,
  user: typeof CurrentUser.Service,
  entry: ProtectedRelationalEntry,
  id: string,
) =>
  entry.entity
    ? gate.authorize(actor(user), { cube: entry.name, entityType: entry.entity, entityId: id }, "read").pipe(
        Effect.map((decision) => decision.allowed),
        Effect.orDie,
      )
    : Effect.succeed(false)

/**
 * One `authorizeList`, one cube search for exactly the asked page filtered by `only`, one
 * `entity.list` audit row (Qwbe#73). A cube that ignores `only` gets a short page, never a leak.
 */
const protectedSearch = (
  entry: ProtectedRelationalEntry,
  gate: RelationalGate,
  field: string,
  value: string,
  page: PageRequest,
): Effect.Effect<SearchResult, never, CurrentUser> =>
  Effect.gen(function* () {
    const search = entry.relational?.search
    if (!search || !entry.entity) return { rows: [], total: 0 }
    const user = yield* CurrentUser
    const scope = { cube: entry.name, entityType: entry.entity }
    const visible = yield* gate.authorizeList(actor(user), scope, "read").pipe(Effect.orDie)
    const source = visible !== "all" ? "scoped" : user.roles.includes("admin") ? "superadmin" : "cube-admin"
    const audit = (ids: ReadonlyArray<string>) =>
      gate.auditList(actor(user), scope, "read", source, ids).pipe(Effect.orDie)
    // Empty `ids` means "no filter" to the store, so an actor who sees nothing never reaches it.
    if (visible !== "all" && visible.size === 0) {
      yield* audit([])
      return { rows: [], total: 0 }
    }
    const found = yield* search(field, value, page, visible)
    const rows = visible === "all" ? found.rows : found.rows.filter((row) => visible.has(row.id))
    yield* audit(rows.map((row) => row.id))
    // A dropped row means the cube counted rows the actor may not see: do not publish that count.
    return { rows, total: rows.length === found.rows.length ? found.total : page.offset + rows.length }
  })

export const protectRelational = (entry: ProtectedRelationalEntry, gate: RelationalGate): ProtectedRelationalEntry => {
  if (entry.permissionExempt || !entry.entity || !entry.relational) return entry
  const source = entry.relational
  return {
    ...entry,
    captureEntity: entry.captureEntity,
    relational: {
      ...(source.search ? { search: (field, value, page) => protectedSearch(entry, gate, field, value, page) } : {}),
      ...(source.summaryById ? { summaryById: source.summaryById } : {}),
      ...(source.fieldValue ? { fieldValue: source.fieldValue } : {}),
    },
  }
}

export const relationalReadAllowed = (
  entry: ProtectedRelationalEntry,
  gate: RelationalGate,
  user: typeof CurrentUser.Service | undefined,
  id: string,
) => (entry.permissionExempt ? Effect.succeed(true) : user ? allowed(gate, user, entry, id) : Effect.succeed(false))
