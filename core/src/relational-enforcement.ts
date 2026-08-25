import { Effect } from "effect"
import { CurrentUser } from "./kernel/auth-contract.ts"
import type { RelationalPart, SearchResult } from "./kernel/manifest.ts"
import type { PageRequest } from "./kernel/pagination.ts"
import { MAX_LIMIT } from "./kernel/pagination.ts"
import type { AccessDecision, EntityRef, PermissionActor } from "./permissions-contracts.ts"

export type RelationalGate = Readonly<{
  authorize: (actor: PermissionActor, ref: EntityRef, action: "read") => Effect.Effect<AccessDecision, unknown>
}>
export type ProtectedRelationalEntry = Readonly<{
  name: string
  entity?: string | undefined
  relational?: RelationalPart | undefined
  permissionExempt?: boolean | undefined
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

const protectedSearch = (
  entry: ProtectedRelationalEntry,
  gate: RelationalGate,
  field: string,
  value: string,
  page: PageRequest,
): Effect.Effect<SearchResult, never, CurrentUser> =>
  Effect.gen(function* () {
    if (!entry.relational?.search) return { rows: [], total: 0 }
    const user = yield* CurrentUser
    const visible = []
    let offset = 0
    while (true) {
      const source = yield* entry.relational.search(field, value, {
        ...page,
        offset,
        limit: Math.min(MAX_LIMIT, Math.max(page.limit, 50)),
      })
      const rows = yield* Effect.filter(source.rows, (row) => allowed(gate, user, entry, row.id))
      visible.push(...rows)
      offset += source.rows.length
      if (source.rows.length === 0 || offset >= source.total) break
    }
    return { rows: visible.slice(page.offset, page.offset + page.limit), total: visible.length }
  })

export const protectRelational = (entry: ProtectedRelationalEntry, gate: RelationalGate): ProtectedRelationalEntry => {
  if (entry.permissionExempt || !entry.entity || !entry.relational) return entry
  const source = entry.relational
  return {
    ...entry,
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
