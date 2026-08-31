// LEVEL 1 — spaces. The virtual directory, and the one genuinely new idea in this iteration.
//
// Level 0 is flat: every cube sits in its own directory, whether it shipped with core or
// arrived in a plugin. They share one namespace and none of them knows another exists.
//
// But something has to say "a note has an author, and that author is an Account". In the
// previous iteration each cube declared its own links, which meant `notes` had the string
// "Account" written inside it. Not an import, so no tool caught it — but still knowledge of
// another cube, and the kind that quietly becomes a dependency.
//
// A space is a directory that contains NO cubes. It contains the CONNECTIONS between them:
//
//     spaces/workspace/index.ts
//       link({ from: "notes", field: "authorId", to: "Account", label: "notes" })
//
// Now `grep -r Account cubes/notes/` returns nothing, and `grep -r notes cubes/account/`
// returns nothing. Either cube can be deleted; the space simply loses a link and says so.
//
// Module links live outside both modules and are declared by a third party. The
// difference from a foreign key is the same one: the association is a third thing, not a
// column one side owns.

import { existsSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const spacesDir = join(here, "..", "spaces")

/**
 * One declared connection.
 *
 * `from` is a cube name, `to` is an entity name. Both are strings on purpose: the space does
 * not import either side, so deleting a cube cannot break the space at load time — only at
 * validation, where the error is a sentence instead of a stack trace.
 */
export type Link = {
  /** The cube that holds the pointing field. */
  readonly from: string
  /** The field on its rows holding the other side's id. */
  readonly field: string
  /** The entity pointed at. */
  readonly to: string
  /** What the list is called on the other side's page, e.g. "notes". */
  readonly label: string
}

export type SpaceDefinition = {
  readonly name: string
  /** Human-facing title, shown as a group heading in the UI. */
  readonly title: string
  readonly links: ReadonlyArray<Link>
}

export const defineSpace = (s: SpaceDefinition): SpaceDefinition => s

/** Convenience so a space file reads as a list of statements. */
export const link = (l: Link): Link => l

export const spaceDirectories = (): ReadonlyArray<string> => {
  if (!existsSync(spacesDir)) return []
  return readdirSync(spacesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort()
}

export class BrokenSpaceError extends Error {
  constructor(space: string, cause: string) {
    super(`Space "${space}" failed to load: ${cause}\nFix it or remove spaces/${space}/.`)
    this.name = "BrokenSpaceError"
  }
}

export const loadSpaces = async (): Promise<ReadonlyArray<SpaceDefinition>> => {
  const out: Array<SpaceDefinition> = []
  for (const dir of spaceDirectories()) {
    let mod: Record<string, unknown>
    try {
      // A checkout loads the space's TypeScript source; the compiled kernel (dist/) loads the
      // index.js the build emitted. Same definition, whichever shape the package ships.
      const entry = existsSync(join(spacesDir, dir, "index.ts")) ? "index.ts" : "index.js"
      mod = (await import(`../spaces/${dir}/${entry}`)) as Record<string, unknown>
    } catch (e) {
      throw new BrokenSpaceError(dir, (e as Error).message)
    }
    const def = mod.space as SpaceDefinition | undefined
    if (!def) throw new BrokenSpaceError(dir, "index.ts does not export `space`")
    if (def.name !== dir) throw new BrokenSpaceError(dir, `name is "${def.name}" but the directory is "${dir}"`)
    out.push(def)
  }
  return out
}

/**
 * Links whose two ends are not both present.
 *
 * No boundary tool can check this — `dependency-cruiser` and friends see physical imports, and
 * here the absence of an import is the whole point. So this stays hand-written. The good news,
 * measured: it is a dozen lines, not a regex over TypeScript.
 *
 * Why it must be checked at all: a typo like `to: "Acount"` shows up in the UI as an empty
 * list, which is indistinguishable from "no data" — so nobody goes looking for it.
 */
export const danglingLinks = (
  spaces: ReadonlyArray<SpaceDefinition>,
  // `| undefined`: callers build this from manifests, where `entity` is optional, so what
  // arrives is `string | undefined` — see the same note on `RegistryEntry`.
  cubes: ReadonlyArray<{ readonly name: string; readonly entity?: string | undefined }>,
): ReadonlyArray<{ readonly space: string; readonly link: Link; readonly reason: string }> => {
  const cubeNames = new Set(cubes.map((c) => c.name))
  const entities = new Set(cubes.filter((c) => c.entity).map((c) => c.entity as string))

  return spaces.flatMap((s) =>
    s.links.flatMap((l) => {
      if (!cubeNames.has(l.from)) return [{ space: s.name, link: l, reason: `no cube named "${l.from}"` }]
      if (!entities.has(l.to)) return [{ space: s.name, link: l, reason: `no mounted cube holds entity "${l.to}"` }]
      return []
    }),
  )
}

/**
 * Links that are live right now: both ends mounted AND enabled.
 *
 * Consulted per call, not once at startup — switching a cube off in Settings must remove its
 * links from everyone else's pages immediately, which is what makes "disabled" mean "does not
 * exist" rather than "returns errors".
 */
export const activeLinks = (
  spaces: ReadonlyArray<SpaceDefinition>,
  // `| undefined`: callers build this from manifests, where `entity` is optional, so what
  // arrives is `string | undefined` — see the same note on `RegistryEntry`.
  cubes: ReadonlyArray<{ readonly name: string; readonly entity?: string | undefined }>,
  isEnabled: (cube: string) => boolean,
): ReadonlyArray<Link> => {
  const holder = new Map(cubes.filter((c) => c.entity).map((c) => [c.entity as string, c.name]))
  return spaces.flatMap((s) =>
    s.links.filter((l) => {
      const target = holder.get(l.to)
      return !!target && isEnabled(l.from) && isEnabled(target)
    }),
  )
}
