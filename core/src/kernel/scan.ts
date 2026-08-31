// The disk walk behind `discover`: which cube directories exist, and under which parent.
//
// Split out of discovery.ts on 2026-08-11 (size cap -- the rule is "split the file, don't
// raise the number"). The hierarchy rules live here because they ARE the walk: a cube
// directory whose subdirectories are themselves cubes is a PARENT, children are addressed
// `<parent>/<child>`, and discovery is one level deep only (docs/booktags-hierarchy.md).

import { existsSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { BrokenCubeError, DuplicateCubeError } from "./errors-discovery.ts"

const here = dirname(fileURLToPath(import.meta.url))
const cubesDir = join(here, "..", "cubes")
/** Where installed packages live. Exported so the boot-time package contract judges the same
 *  directory discovery mounts from -- two spellings of this path would drift. */
export const pluginsDir = join(here, "..", "..", "plugins")

export const subdirectories = (dir: string): ReadonlyArray<string> => {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort()
}

/** Everything on disk, in load order: core cubes first, then each plugin's. */
export const discover = (): ReadonlyArray<{ name: string; plugin: string | null; specifier: string }> => {
  const found: Array<{ name: string; plugin: string | null; specifier: string }> = []

  const scan = (dir: string, plugin: string | null, parent: string | null): void => {
    for (const name of subdirectories(dir)) {
      const nested = join(dir, name)
      const specifier = parent
        ? plugin
          ? `../../plugins/${plugin}/cubes/${parent}/${name}/index.ts`
          : `../cubes/${parent}/${name}/index.ts`
        : plugin
          ? `../../plugins/${plugin}/cubes/${name}/index.ts`
          : `../cubes/${name}/index.ts`
      // Only directories that actually export a cube are scanned. A parent may hold assets/,
      // fixtures/ or migrations/ next to its children -- those are NOT cubes, and importing
      // their index.ts would stop the boot. A cube directory without index.ts is caught as
      // BrokenCubeError at load time, exactly like a flat one.
      if (!existsSync(join(nested, "index.ts"))) continue
      const full = parent ? `${parent}/${name}` : name
      found.push({ name: full, plugin, specifier })
      if (parent) {
        // One level only (DIRECTION.md section 2.4). Deeper directories are refused loudly.
        const deep = subdirectories(nested).filter((d) => existsSync(join(nested, d, "index.ts")))
        if (deep.length > 0) {
          throw new BrokenCubeError(
            full,
            `contains nested cube directories (${deep.join(", ")}) -- hierarchy is exactly one level. ` +
              `See docs/booktags-hierarchy.md section invariants.`,
          )
        }
      } else {
        scan(nested, plugin, name)
      }
    }
  }

  scan(cubesDir, null, null)
  for (const plugin of subdirectories(pluginsDir)) {
    scan(join(pluginsDir, plugin, "cubes"), plugin, null)
  }

  // Names collide across the flat namespace -> refuse, with both sources named.
  const seen = new Map<string, string>()
  for (const f of found) {
    const source = f.plugin ? `plugin "${f.plugin}"` : "core"
    const previous = seen.get(f.name)
    if (previous) throw new DuplicateCubeError(f.name, [previous, source])
    seen.set(f.name, source)
  }

  return found
}
