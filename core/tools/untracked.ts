import * as Effect from "effect/Effect"
import { gitLines } from "./git.ts"
import { unitsOnlyUntracked } from "./mount-units.ts"

// A unit that mounts at boot but has no file in git runs here and is missing from every clone.

/** Mount units that have untracked files and no tracked file at all. */
export const untrackedUnits = (root: string) =>
  Effect.all([gitLines(root, "ls-files", "--others", "--exclude-standard"), gitLines(root, "ls-files")]).pipe(
    Effect.map(([untracked, tracked]) => unitsOnlyUntracked(untracked, tracked)),
  )
