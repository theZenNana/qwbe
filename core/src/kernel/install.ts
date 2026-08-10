// Installing and removing cubes — the capability behind the install page.
//
// The invariant this file must not break is the one in `manifest.ts`:
//
//     ONE CUBE = ONE DIRECTORY. INSTALLING IT TOUCHES NO EXISTING FILE.
//
// So installing is literally copying a directory, and removing is deleting one. There is no
// registry to append to, no `cubes.ts` to edit, nothing to migrate. That is the whole point:
// if installation had to edit a shared file, two cubes installed by two people would conflict
// in that file, and "independent" would be a slogan.
//
// WHY THIS LIVES IN THE KERNEL, not in the settings cube:
//
// Cubes may not touch `node:fs` — a boundary rule enforces it, because a cube with a filesystem
// handle can open another cube's database and the isolation story collapses. The settings cube
// is not exempt: a rule that carves out an exception for whoever enforces it stops being a rule.
// So the kernel owns the filesystem and hands out a NARROW capability, granted on the same
// declared basis as the switches (`managesCubes: true` in the manifest, at most one cube).
//
// WHAT THE CAPABILITY DELIBERATELY CANNOT DO — this is the security surface, so it is written
// out rather than implied:
//
//   * It cannot copy from anywhere. Sources come only from the store directory, one level deep.
//   * It cannot write anywhere. Destinations are only `src/cubes/<name>` or `plugins/<name>`.
//   * It cannot be handed a path. It takes a NAME, matched against a strict pattern, and every
//     resolved path is re-checked to sit under its allowed root — belt and braces, because the
//     pattern is the kind of thing that gets relaxed later by someone in a hurry.
//   * It cannot overwrite. An install onto an existing directory is refused, not merged: the
//     invariant says no existing file is touched, and a merge touches files.
//   * It cannot remove a required cube. Removing `auth` from a web page is the button that cuts
//     the branch it sits on.
//
// WHAT IT HONESTLY CANNOT PROMISE: the kernel discovers cubes at STARTUP. Writing the directory
// does not mount it. The caller is told `requiresRestart: true` rather than being shown a route
// list that is not live yet — a page that lies about what happened is worse than one that asks
// you to restart.

import { exec } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { CubeInstaller, CubePackage } from "./manifest.ts"

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(here, "..")

/** Where installable packages sit. Overridable so the probes can point at a scratch copy. */
const storeDir = resolve(process.env.QWBE_STORE_DIR ?? join(srcDir, "..", "store"))
const cubesDir = resolve(join(srcDir, "cubes"))
const pluginsDir = resolve(join(srcDir, "..", "plugins"))

/** The metadata file that makes a directory in the store a package rather than scratch. */
const MANIFEST = "qwbe-package.json"

/**
 * Names allowed for a package, a cube, or a plugin.
 *
 * Lowercase, starts with a letter, no dots and no separators — so `..`, `./x`, `a/b`, `a\b`,
 * absolute paths and Windows drive letters are all rejected by the shape, before any path is
 * built from them.
 */
const NAME = /^[a-z][a-z0-9-]{0,31}$/

export class InstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InstallError"
  }
}

/**
 * Guard every path that leaves this module.
 *
 * `resolve` collapses `..` before the check, so a name that slipped through the pattern still
 * cannot climb out of its root. The trailing separator matters: without it, `/plugins-evil`
 * passes a `startsWith("/plugins")` test.
 */
const under = (root: string, path: string): string => {
  const full = resolve(path)
  if (full !== root && !full.startsWith(root + sep)) {
    throw new InstallError(`refused: resolved path "${full}" is outside "${root}"`)
  }
  return full
}

const checkName = (kind: string, name: string): string => {
  if (!NAME.test(name)) {
    throw new InstallError(
      `refused: ${kind} name "${name}" is not allowed. ` +
        `Use lowercase letters, digits and dashes, starting with a letter (max 32).`,
    )
  }
  return name
}

const sizeOf = (dir: string): number => {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    total += entry.isDirectory() ? sizeOf(p) : statSync(p).size
  }
  return total
}

/**
 * Every cube name currently on disk, wherever it came from.
 *
 * The kernel already refuses to start when two cubes share a name (`DuplicateCubeError`) — that
 * rule is right, and it is what turned this into a real failure: two store packages both brought
 * a cube called `contacts`, install accepted the second, and the next startup died. The server
 * did not come up at all, which from a button in a web page is the worst outcome available.
 *
 * So the same question the kernel asks at startup gets asked one step earlier, at install time,
 * where it can still be answered with a refusal instead of a dead process.
 */
const cubesOnDisk = (): ReadonlyArray<{ cube: string; from: string }> => {
  const found: Array<{ cube: string; from: string }> = []
  const dirsIn = (d: string) =>
    existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()) : []

  for (const e of dirsIn(cubesDir)) found.push({ cube: e.name, from: "core" })
  for (const p of dirsIn(pluginsDir)) {
    for (const e of dirsIn(join(pluginsDir, p.name, "cubes"))) {
      found.push({ cube: e.name, from: `plugin ${p.name}` })
    }
  }
  return found
}

const destinationOf = (pkg: { name: string; kind: "cube" | "plugin" }): string =>
  pkg.kind === "plugin" ? under(pluginsDir, join(pluginsDir, pkg.name)) : under(cubesDir, join(cubesDir, pkg.name))

const readPackage = (name: string): CubePackage => {
  checkName("package", name)
  const dir = under(storeDir, join(storeDir, name))
  const manifestPath = join(dir, MANIFEST)
  if (!existsSync(manifestPath)) {
    throw new InstallError(`refused: "${name}" is not a package — no ${MANIFEST} in the store`)
  }

  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    name?: string
    kind?: string
    summary?: string
    cubes?: Array<string>
  }

  if (raw.name !== name) {
    // A package whose manifest names something else would install under one name and appear
    // under another — the first step of shadowing an existing cube.
    throw new InstallError(`refused: package directory "${name}" declares name "${raw.name}"`)
  }
  if (raw.kind !== "cube" && raw.kind !== "plugin") {
    throw new InstallError(`refused: package "${name}" declares kind "${raw.kind}" — expected cube or plugin`)
  }

  const cubes = raw.kind === "plugin" ? (raw.cubes ?? []) : [name]
  for (const c of cubes) checkName("cube", c)

  const kind = raw.kind
  const installed = existsSync(destinationOf({ name, kind }))
  // A package already installed does not "conflict with itself" — its own cubes are on disk
  // precisely because it put them there.
  const mine = new Set(installed ? cubes : [])
  const taken = cubesOnDisk()
    .filter((c) => !mine.has(c.cube))
    .map((c) => c.cube)

  return {
    name,
    kind,
    summary: raw.summary ?? "",
    cubes,
    installed,
    bytes: sizeOf(dir),
    conflicts: cubes.filter((c) => taken.includes(c)),
  }
}

export const installerFor = (): CubeInstaller => ({
  cubeOnDisk: (cube: string, plugin: string | null) => {
    // Discovery predates the package slug grammar and mounts any non-hidden directory. This
    // read capability must describe that state without turning the whole settings catalogue
    // into a 500. Write operations below remain strict and still call checkName.
    if (!NAME.test(cube) || (plugin !== null && !NAME.test(plugin))) return false
    return existsSync(
      plugin ? under(pluginsDir, join(pluginsDir, plugin, "cubes", cube)) : under(cubesDir, join(cubesDir, cube)),
    )
  },

  available: () => {
    if (!existsSync(storeDir)) return []
    return readdirSync(storeDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && NAME.test(e.name))
      .flatMap((e) => {
        try {
          return [readPackage(e.name)]
        } catch {
          // A malformed package in the store must not take the whole list down — the page has
          // to keep working so you can install the ones that are fine.
          return []
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  },

  install: (name: string) => {
    const pkg = readPackage(name)
    const from = under(storeDir, join(storeDir, name))
    const to = destinationOf(pkg)

    if (existsSync(to)) {
      throw new InstallError(
        `refused: "${to.replace(srcDir, "src")}" already exists. ` +
          `Installing never overwrites — remove it first if that is what you meant.`,
      )
    }

    // Refused here rather than discovered at the next startup. The kernel's duplicate-name rule
    // is correct and fatal, so letting the copy through would trade a clear "no" for a server
    // that will not come up — and the person who clicked would have no way to connect the two.
    const clash = cubesOnDisk().filter((c) => pkg.cubes.includes(c.cube))
    if (clash.length > 0) {
      throw new InstallError(
        `refused: "${name}" brings ${clash.map((c) => `"${c.cube}"`).join(", ")}, ` +
          `already on disk (${clash.map((c) => c.from).join(", ")}). ` +
          `Two cubes cannot share a name — the server would refuse to start at all. ` +
          `Remove the other one first if this is the one you want.`,
      )
    }

    mkdirSync(dirname(to), { recursive: true })
    // The package manifest is store bookkeeping, not part of the cube. Copying it would put a
    // file inside the installed directory that the cube itself never declared.
    cpSync(from, to, { recursive: true, filter: (src) => !src.endsWith(sep + MANIFEST) })

    return { ...pkg, installed: true }
  },

  uninstallPackage: (name: string) => {
    const pkg = readPackage(name)
    const to = destinationOf(pkg)
    if (!existsSync(to)) {
      throw new InstallError(`refused: "${name}" is not installed — nothing at "${to.replace(srcDir, "src")}"`)
    }
    rmSync(to, { recursive: true, force: true })
    return { removed: to.replace(resolve(srcDir, ".."), "."), cubes: pkg.cubes }
  },

  // Reply first, die second — the caller must hear "yes" before the port goes away. The delay is
  // what makes that true; without it the response and the exit race, and the loser is the person
  // clicking the button.
  restart: () => {
    setTimeout(() => {
      if ((process.env.QWBE_RESTART_MODE ?? "inband") === "command") {
        const cmd = process.env.QWBE_RESTART_CMD ?? "systemctl --user restart qwbe"
        exec(cmd, (e) => {
          if (e) console.error(`[install] restart command failed: ${e.message}`)
        })
      } else {
        process.exit(0)
      }
    }, 300)
  },

  remove: (cube: string, plugin: string | null) => {
    checkName("cube", cube)
    const target = plugin
      ? under(pluginsDir, join(pluginsDir, checkName("plugin", plugin)))
      : under(cubesDir, join(cubesDir, cube))

    if (!existsSync(target)) {
      throw new InstallError(`refused: nothing to remove at "${target.replace(srcDir, "src")}"`)
    }
    rmSync(target, { recursive: true, force: true })
    return { removed: target.replace(resolve(srcDir, ".."), ".") }
  },
})
