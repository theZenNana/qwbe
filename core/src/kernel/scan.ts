// The disk walk behind `discover`: which cube directories exist, and under which parent.
//
// The hierarchy rules live here because they ARE the walk: a cube
// directory whose subdirectories are themselves cubes is a PARENT, children are addressed
// `<parent>/<child>`, and discovery is one level deep only (docs/booktags-hierarchy.md).

import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { FileSystem } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { Effect } from "effect"
import { readPluginsDir } from "../config.ts"
import { subdirectories as directoriesIn } from "../files.ts"
import { BrokenCubeError, DuplicateCubeError } from "./errors-discovery.ts"

const here = dirname(fileURLToPath(import.meta.url))
const cubesDir = join(here, "..", "cubes")

/** A directory counts only if it carries a cube entry: index.ts for a plugin (packs ship
 *  sources), index.ts or index.js for a core cube -- `index.js` in the compiled kernel the
 *  tarball installs (dist/ has the .js emit, not the .ts source). Packs always ship TypeScript
 *  sources -- their cubes are read from their own directory, outside node_modules -- so plugin
 *  cubes stay .ts and only the kernel's own need the lookup. */
const entryOf = (dir: string, plugin: string | null) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (yield* fs.exists(join(dir, "index.ts"))) return "index.ts"
    if (!plugin && (yield* fs.exists(join(dir, "index.js")))) return "index.js"
    return null
  })

/** Where installed packages live. Exported so the boot-time package contract judges the same
 *  directory discovery mounts from -- two spellings of this path would drift. Overridable the
 *  way the store is (QWBE_STORE_DIR): `qwbe check` points it at a sandbox holding exactly the
 *  one package being checked, so a check never touches the packages a checkout really has. */
export const pluginsDir = resolve(readPluginsDir(join(here, "..", "..", "plugins")))

const subdirectories = (dir: string) =>
  Effect.map(directoriesIn(dir), (names) => names.filter((n) => !n.startsWith("_") && !n.startsWith(".")).sort())

/** Everything on disk, in load order: core cubes first, then each plugin's. */
export const discover = Effect.gen(function* () {
  const found: Array<{ name: string; plugin: string | null; specifier: string }> = []

  const scan = (
    dir: string,
    plugin: string | null,
    parent: string | null,
  ): Effect.Effect<void, BrokenCubeError | PlatformError, FileSystem.FileSystem> =>
    Effect.gen(function* () {
      for (const name of yield* subdirectories(dir)) {
        const nested = join(dir, name)
        const entry = yield* entryOf(nested, plugin)
        if (entry === null) continue
        const specifier = parent
          ? plugin
            ? join(pluginsDir, plugin, "cubes", parent, name, entry)
            : join(cubesDir, parent, name, entry)
          : plugin
            ? join(pluginsDir, plugin, "cubes", name, entry)
            : join(cubesDir, name, entry)
        // Only directories that actually export a cube are scanned. A parent may hold assets/,
        // fixtures/ or migrations/ next to its children -- those are NOT cubes, and importing
        // their index.ts would stop the boot. A cube directory without index.ts is caught as
        // BrokenCubeError at load time, exactly like a flat one.
        const full = parent ? `${parent}/${name}` : name
        found.push({ name: full, plugin, specifier })
        if (parent) {
          // One level only (DIRECTION.md section 2.4). Deeper directories are refused loudly.
          const deep = yield* Effect.filter(yield* subdirectories(nested), (d) =>
            Effect.map(entryOf(join(nested, d), plugin), (e) => e !== null),
          )
          if (deep.length > 0) {
            return yield* new BrokenCubeError(
              full,
              `contains nested cube directories (${deep.join(", ")}) -- hierarchy is exactly one level. ` +
                `See docs/booktags-hierarchy.md section invariants.`,
            )
          }
        } else {
          yield* scan(nested, plugin, name)
        }
      }
    })

  yield* scan(cubesDir, null, null)
  for (const plugin of yield* subdirectories(pluginsDir)) {
    yield* scan(join(pluginsDir, plugin, "cubes"), plugin, null)
  }

  // Names collide across the flat namespace -> refuse, with both sources named.
  const seen = new Map<string, string>()
  for (const f of found) {
    const source = f.plugin ? `plugin "${f.plugin}"` : "core"
    const previous = seen.get(f.name)
    if (previous) return yield* new DuplicateCubeError(f.name, [previous, source])
    seen.set(f.name, source)
  }

  return found
})
