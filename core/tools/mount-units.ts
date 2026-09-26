// Pure: which mount unit a repo path belongs to. No I/O in this module.

const MOUNT_POINTS = ["core/src/cubes/", "core/src/spaces/", "core/plugins/", "core/store/"]

/** The mount unit of `file` ("core/plugins/pack/"), or undefined outside every mount point. */
export const unitOf = (file: string) => {
  const point = MOUNT_POINTS.find((prefix) => file.startsWith(prefix))
  const name = point && file.slice(point.length).split("/")[0]
  return point && name && !name.startsWith(".") && !name.startsWith("_") ? `${point}${name}/` : undefined
}

/** Units that have untracked files and no tracked file at all, sorted. */
export const unitsOnlyUntracked = (untracked: ReadonlyArray<string>, tracked: ReadonlyArray<string>) => {
  const trackedUnits = new Set(tracked.map(unitOf))
  const units = new Set(untracked.map(unitOf).filter((unit) => unit !== undefined))
  return [...units].filter((unit) => !trackedUnits.has(unit)).sort()
}
