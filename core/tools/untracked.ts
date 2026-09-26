import * as Effect from "effect/Effect"
import { gitLines } from "./git.ts"

// A unit that mounts at boot but has no file in git runs here and is missing from every clone.
const MOUNT_POINTS = ["core/src/cubes/", "core/src/spaces/", "core/plugins/", "core/store/"]

const unitOf = (file: string) => {
  const point = MOUNT_POINTS.find((prefix) => file.startsWith(prefix))
  const name = point && file.slice(point.length).split("/")[0]
  return point && name && !name.startsWith(".") && !name.startsWith("_") ? `${point}${name}/` : undefined
}

const unitsIn = (files: ReadonlyArray<string>) => new Set(files.map(unitOf).filter((unit) => unit !== undefined))

/** Mount units that have untracked files and no tracked file at all. */
export const untrackedUnits = (root: string) =>
  Effect.gen(function* () {
    const untracked = unitsIn(yield* gitLines(root, "ls-files", "--others", "--exclude-standard"))
    const tracked = unitsIn(yield* gitLines(root, "ls-files"))
    return [...untracked].filter((unit) => !tracked.has(unit)).sort()
  })
