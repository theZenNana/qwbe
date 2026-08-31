// The disk walk behind `discover`: which cube directories exist, and under which parent.
//
// Split out of discovery.ts on 2026-08-11 (size cap -- the rule is "split the file, don't
// raise the number"). The hierarchy rules live here because they ARE the walk: a cube
// directory whose subdirectories are themselves cubes is a PARENT, children are addressed
// `<parent>/<child>`, and discovery is one level deep only (docs/booktags-hierarchy.md).

import { existsSync, readdirSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { BrokenCubeError, DuplicateCubeError } from "./errors-discovery.ts"

const here = dirname(fileURLToPath(import.meta.url))
const cubesDir = join(here, "..", "cubes")

/**
 * A core cube's entry file: `index.ts` in a checkout, `index.js` in the compiled kernel the
 * tarball installs (dist/ has the .js emit, not the .ts source). Packs always ship TypeScript
 * sources -- their cubes are read from their own directory, outside node_modules -- so plugin
 * cubes stay .ts and only the kernel's own need the lookup.
 */
const coreEntry = (dir: string): string | null => {
  if (existsSync(join(dir, "index.ts"))) return "index.ts"
  if (existsSync(join(dir, "index.js"))) return "index.js"
  return null
}
/** Where installed packages live. Exported so the boot-time package contract judges the same
 *  directory discovery mounts from -- two spellings of this path would drift. Overridable the
 *  way the store is (QWBE_STORE_DIR): `qwbe check` points it at a sandbox holding exactly the
 *  one package being checked, so a check never touches the packages a checkout really has. */
export const pluginsDir = resolve(process.env.QWBE_PLUGINS_DIR ?? join(here, "..", "..", "plugins"))

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

  // The import specifier is built FROM pluginsDir, not spelled `../../plugins/...`: discovery
  // finds and loads the same tree. With QWBE_PLUGINS_DIR unset this is byte-identical to the
  // old spelling; with the override set (qwbe check's sandbox) the two would otherwise point
  // at different directories -- find the pack in the sandbox, import it from the checkout.
  const pluginsRoot = relative(here, pluginsDir)

  const scan = (dir: string, plugin: string | null, parent: string | null): void => {
    for (const name of subdirectories(dir)) {
      const nested = join(dir, name)
      // A directory counts only if it carries a cube entry: index.ts for a plugin (packs ship
      // sources), index.ts or index.js for a core cube (source vs compiled kernel).
      const entry = plugin ? (existsSync(join(nested, "index.ts")) ? "index.ts" : null) : coreEntry(nested)
      if (entry === null) continue
      const specifier = parent
        ? plugin
          ? join(pluginsRoot, plugin, "cubes", parent, name, entry)
          : join("../cubes", parent, name, entry)
        : plugin
          ? join(pluginsRoot, plugin, "cubes", name, entry)
          : join("../cubes", name, entry)
      // Only directories that actually export a cube are scanned. A parent may hold assets/,
      // fixtures/ or migrations/ next to its children -- those are NOT cubes, and importing
      // their index.ts would stop the boot. A cube directory without index.ts is caught as
      // BrokenCubeError at load time, exactly like a flat one.
      const full = parent ? `${parent}/${name}` : name
      found.push({ name: full, plugin, specifier })
      if (parent) {
        // One level only (DIRECTION.md section 2.4). Deeper directories are refused loudly.
        const deep = subdirectories(nested).filter((d) =>
          plugin ? existsSync(join(nested, d, "index.ts")) : coreEntry(join(nested, d)) !== null,
        )
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
