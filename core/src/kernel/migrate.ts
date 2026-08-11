// One-time data migrations between store file names, run at mount before any cube opens its
// database.
//
// Split out of discovery.ts on 2026-08-11 when the hierarchy work pushed that file past its
// size cap. The rule is the config's: split the file, don't raise the number.

import { existsSync, renameSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = process.env.QWBE_DATA_DIR ?? join(here, "..", "..", "..", "data")

export class MigrationConflictError extends Error {
  constructor(from: string, to: string) {
    super(
      `Data migration refused: both "${from}" and "${to}" exist in the data directory. ` +
        `One of them must be removed by hand -- choosing one silently would be choosing which ` +
        `data to lose.`,
    )
    this.name = "MigrationConflictError"
  }
}

/**
 * Each entry renames an old cube's file to a new cube's file -- the schema is unchanged, only
 * the owning identity moved (flat `bookmarks` -> `booktags/bookmarks`).
 *
 * Refuses rather than guesses: the rename happens only when the old file exists and the new
 * one does not. Both existing is a human decision, not a heuristic.
 */
const DATA_MIGRATIONS: ReadonlyArray<{ readonly from: string; readonly to: string }> = [
  { from: "bookmarks.sqlite", to: "booktags--bookmarks.sqlite" },
  { from: "tags.sqlite", to: "booktags--tags.sqlite" },
]

export const migrateDataFiles = (): void => {
  for (const { from, to } of DATA_MIGRATIONS) {
    const oldPath = join(dataDir, from)
    const newPath = join(dataDir, to)
    if (!existsSync(oldPath)) continue
    if (existsSync(newPath)) throw new MigrationConflictError(from, to)
    renameSync(oldPath, newPath)
    // WAL companions travel with the database -- renaming only the main file would leave
    // uncommitted pages behind attached to a name nothing opens any more.
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${oldPath}${suffix}`)) renameSync(`${oldPath}${suffix}`, `${newPath}${suffix}`)
    }
  }
}
