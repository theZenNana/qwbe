import * as Effect from "effect/Effect"
import { captureLines } from "../shared/process.ts"

// A directory here mounts at boot, so git has to know it: otherwise a clone runs another system.
const MOUNT_POINTS = ["core/src/cubes/", "core/src/spaces/", "core/plugins/", "core/store/"]

export const unitOf = (file: string) => {
  const point = MOUNT_POINTS.find((prefix) => file.startsWith(prefix))
  const [name, ...rest] = point ? file.slice(point.length).split("/") : []
  return name && rest.length > 0 && !/^[._]/.test(name) ? `${point}${name}/` : undefined
}

const unitsOf = (files: ReadonlyArray<string>) => new Set(files.map(unitOf).filter((unit) => unit !== undefined))

// A unit is a ghost only when git tracks none of it; a tracked cube with a new file is normal work.
export const ghostUnits = (untrackedFiles: ReadonlyArray<string>, trackedFiles: ReadonlyArray<string>) => {
  const known = unitsOf(trackedFiles)
  return [...unitsOf(untrackedFiles)].filter((unit) => !known.has(unit))
}

// Reads git, never writes to it.
export const untracked = (root: string) =>
  Effect.gen(function* () {
    const tracked = yield* captureLines(["git", "ls-files"], root)
    const others = yield* captureLines(["git", "ls-files", "--others", "--exclude-standard"], root)
    return ghostUnits(others, tracked)
  })
