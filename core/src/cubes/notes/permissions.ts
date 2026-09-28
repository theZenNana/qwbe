import { Effect } from "effect"
import type { CubeTools } from "qwbe-core/cube"
import type { PermissionService } from "qwbe-core/permissions"

type Note = Readonly<{ id: string; authorId: string | null; deleted: boolean }>
type OwnershipWriter = Pick<PermissionService, "ownership" | "claim">
export const LEGACY_UNOWNED = "legacy-unowned"
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
