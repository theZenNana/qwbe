import { Effect } from "effect"
import type { CurrentUser } from "qwbe-core/auth"
import type { CubeTools } from "qwbe-core/cube"
import type { PageRequest } from "qwbe-core/pagination"
import type { PermissionService } from "qwbe-core/permissions"

type Note = Readonly<{ id: string; authorId: string | null; deleted: boolean }>
type OwnershipWriter = Pick<PermissionService, "ownership" | "claim">
export const LEGACY_UNOWNED = "legacy-unowned"
const actor = (user: typeof CurrentUser.Service) => ({ userId: user.id, roles: user.roles })
const reference = (note: Note) => ({ cube: "notes", entityType: "Note", entityId: note.id })

// Boot only: every live note gets an owner before any request lists notes.
// ponytail: one ownership read per note, the permission service has no bulk ownership read; add one if boot gets slow.
export const migrateLegacyNotes = <Row extends Note>(store: CubeTools["store"], permissions: OwnershipWriter) =>
  Effect.gen(function* () {
    const notes = (yield* store.all<Row>("notes")).filter((note) => !note.deleted)
    let migrated = 0
    for (const note of notes) {
      const ref = reference(note)
      if (yield* permissions.ownership(ref)) continue
      const ownerId = note.authorId ?? LEGACY_UNOWNED
      yield* permissions.claim({ userId: ownerId, roles: [] }, ref).pipe(Effect.orDie)
      migrated += 1
    }
    return migrated
  })

export const visibleNotesPage = <Row extends Note>(
  store: CubeTools["store"],
  permissions: Pick<PermissionService, "authorize">,
  user: typeof CurrentUser.Service,
  request: PageRequest,
) =>
  Effect.gen(function* () {
    const notes = [...(yield* store.all<Row>("notes"))].filter((note) => !note.deleted)
    const visible = yield* Effect.filter(notes, (note) =>
      permissions.authorize(actor(user), reference(note), "read").pipe(
        Effect.orDie,
        Effect.map((decision) => decision.allowed),
      ),
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
