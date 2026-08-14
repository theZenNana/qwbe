import { Effect } from "effect"
import type { CurrentUser } from "qwbe-core/auth"
import type { CubeTools } from "qwbe-core/cube"
import type { PageRequest } from "qwbe-core/pagination"
import type { PermissionService } from "qwbe-core/permissions"

type Note = Readonly<{ id: string; authorId: string | null; deleted: boolean }>
const actor = (user: typeof CurrentUser.Service) => ({ userId: user.id, roles: user.roles })
const reference = (note: Note) => ({ cube: "notes", entityType: "Note", entityId: note.id })

export const visibleNotesPage = <Row extends Note>(
  store: CubeTools["store"],
  permissions: PermissionService,
  user: typeof CurrentUser.Service,
  request: PageRequest,
) =>
  Effect.gen(function* () {
    const notes = [...(yield* store.all<Row>("notes"))].filter((note) => !note.deleted)
    const visible = yield* Effect.filter(notes, (note) =>
      Effect.gen(function* () {
        const ref = reference(note)
        if (!(yield* permissions.ownership(ref))) {
          const legacyOwner = note.authorId ?? (user.roles.includes("admin") ? user.id : undefined)
          if (legacyOwner) yield* permissions.claim({ userId: legacyOwner, roles: user.roles }, ref).pipe(Effect.orDie)
        }
        return (yield* permissions.authorize(actor(user), ref, "read")).allowed
      }),
    )
    const field = request.sortBy ?? "createdAt"
    visible.sort((left, right) =>
      String((left as Record<string, unknown>)[field] ?? "").localeCompare(
        String((right as Record<string, unknown>)[field] ?? ""),
      ),
    )
    if (request.descending) visible.reverse()
    return {
      rows: visible.slice(request.offset, request.offset + request.limit),
      total: visible.length,
      offset: request.offset,
      limit: request.limit,
      sortedBy: field,
    }
  })
