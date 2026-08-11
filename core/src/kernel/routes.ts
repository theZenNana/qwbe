// Route ownership -- what makes prefix-based switching sound.
//
// Split out of mount.ts on 2026-08-11 (size cap): the checks that tie a cube's URL prefix
// to its identity, plus the errors they throw. `rejectDisabled` matches on the first path
// segment, so that segment must belong to exactly one cube -- these are the gates that make
// the match exact instead of hopeful.

import type { MountedCube } from "./discovery.ts"
import { dashForm, pathPrefix } from "./manifest.ts"

export class RouteOwnershipError extends Error {
  constructor(problems: ReadonlyArray<{ cube: string; path: string; prefix: string }>) {
    super(
      `Cubes declaring routes outside their own prefix:\n` +
        problems.map((p) => `  - cube "${p.cube}" declares ${p.path} (prefix "${p.prefix}")`).join("\n") +
        `\nEvery route must start with the cube's own name. Without that rule, a cube can serve ` +
        `endpoints under another cube's prefix -- and switching a cube off, which matches on the ` +
        `first path segment, then misses them entirely. Demonstrated by review: a hostile cube ` +
        `kept answering on /notes/backdoor after Settings reported it disabled.`,
    )
    this.name = "RouteOwnershipError"
  }
}

export class PrefixCollisionError extends Error {
  constructor(prefix: string, cubes: ReadonlyArray<string>) {
    super(
      `More than one cube serves routes under "/${prefix}": ${cubes.join(", ")}. ` +
        `The on/off switch matches the first path segment, so a shared segment makes one cube ` +
        `unreachable by it. A child in this position serves under "<parent>-<name>" instead.`,
    )
    this.name = "PrefixCollisionError"
  }
}

export class DuplicateGroupError extends Error {
  constructor(identifier: string, cubes: ReadonlyArray<string>) {
    super(
      `More than one cube built a contract group called "${identifier}": ${cubes.join(", ")}. ` +
        `The composed API matches handlers by group name, so a duplicate silently misroutes. ` +
        `A child names its group after the prefix it actually serves.`,
    )
    this.name = "DuplicateGroupError"
  }
}

/** The first URL segment a cube actually serves under. */
export const routePrefixOf = (c: MountedCube): string | undefined => {
  const group = c.parts.group as { endpoints?: Record<string, { path?: string }> }
  const first = Object.values(group.endpoints ?? {})[0]
  return first?.path ? pathPrefix(first.path) : undefined
}

/** The group identifier the composed API matches handlers by. */
export const groupIdOf = (c: MountedCube): string =>
  (c.parts.group as { identifier?: string }).identifier ?? c.manifest.name

/**
 * Every endpoint of a cube must live under its own prefix, and no two cubes may share one.
 *
 * A child whose leaf name is already taken by a standalone cube (`booktags/settings` next
 * to core `settings`) serves under `<parent>-<name>` -- unique by construction, and still
 * matched exactly by the switch.
 */
export const checkRouteOwnership = (cubes: ReadonlyArray<MountedCube>): void => {
  const problems: Array<{ cube: string; path: string; prefix: string }> = []
  // A cube with no endpoints owns no routes -- a parent is exactly this case.
  for (const c of cubes) {
    const allowed = new Set([c.manifest.name, dashForm(c.name)])
    const group = c.parts.group as { endpoints?: Record<string, { path?: string }> }
    for (const e of Object.values(group.endpoints ?? {})) {
      const path = e.path ?? ""
      const prefix = pathPrefix(path) ?? ""
      if (!allowed.has(prefix)) {
        problems.push({ cube: c.name, path, prefix })
      }
    }
  }
  if (problems.length > 0) throw new RouteOwnershipError(problems)

  const byPrefix = new Map<string, Array<string>>()
  for (const c of cubes) {
    const prefix = routePrefixOf(c)
    if (!prefix) continue
    const list = byPrefix.get(prefix) ?? []
    list.push(c.name)
    byPrefix.set(prefix, list)
  }
  for (const [prefix, names] of byPrefix) {
    if (names.length > 1) throw new PrefixCollisionError(prefix, names)
  }

  // Two contract groups with the same identifier -- the composed API would misroute.
  const byGroup = new Map<string, Array<string>>()
  for (const c of cubes) {
    const id = groupIdOf(c)
    const list = byGroup.get(id) ?? []
    list.push(c.name)
    byGroup.set(id, list)
  }
  for (const [id, names] of byGroup) {
    if (names.length > 1) throw new DuplicateGroupError(id, names)
  }
}
