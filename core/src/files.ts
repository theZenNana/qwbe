// The one recursive directory walk the installer and the package scanners share, the filtered
// copy built on it, and the Promise edge for callers that are not Effect yet.
//
// Symlinks are reported, never followed: a link inside a package is either refused
// (package-source.ts) or skipped with the directory it sits in, and following one would let a
// walk leave the tree it was pointed at.

import { join, relative } from "node:path"
import { FileSystem } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { NodeContext } from "@effect/platform-node"
import { Cause, Effect, Exit } from "effect"

export type Entry = Readonly<{
  path: string
  name: string
  /** A direct child of the walked root. */
  top: boolean
  type: FileSystem.File.Type
  /** Bytes; 0 for a symlink, which is not followed. */
  size: number
}>

/**
 * Every entry under `root`, depth first, in directory order. `skip` prunes: a skipped entry is
 * left out, and a skipped directory is not entered.
 */
const entriesOf = (fs: FileSystem.FileSystem, dir: string, top: boolean) =>
  Effect.flatMap(fs.readDirectory(dir), (names) =>
    Effect.forEach(names, (name) =>
      Effect.gen(function* () {
        const path = join(dir, name)
        // FileSystem.stat follows links; readLink succeeds only on one.
        const link = yield* fs.readLink(path).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
        const info = link ? undefined : yield* fs.stat(path)
        const entry: Entry = { path, name, top, type: info?.type ?? "SymbolicLink", size: info ? Number(info.size) : 0 }
        return entry
      }),
    ),
  )

export const walk = (root: string, skip: (entry: Entry) => boolean = () => false) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const found: Array<Entry> = []
    const visit = (dir: string): Effect.Effect<void, PlatformError> =>
      Effect.gen(function* () {
        for (const entry of yield* entriesOf(fs, dir, dir === root)) {
          if (skip(entry)) continue
          found.push(entry)
          if (entry.type === "Directory") yield* visit(entry.path)
        }
      })
    yield* visit(root)
    return found
  })

/** Names of the directories directly under `dir`, links not followed; none when `dir` is missing. */
export const subdirectories = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(dir))) return []
    return (yield* entriesOf(fs, dir, true)).filter((e) => e.type === "Directory").map((e) => e.name)
  })

/** Copy `from` into `to`, keeping only the paths `keep` accepts; a refused directory is not entered. */
export const copyTree = (from: string, to: string, keep: (path: string) => boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(to, { recursive: true })
    for (const entry of yield* walk(from, (e) => !keep(e.path))) {
      const target = join(to, relative(from, entry.path))
      if (entry.type === "Directory") yield* fs.makeDirectory(target, { recursive: true })
      else yield* fs.copyFile(entry.path, target)
    }
  })

/**
 * Run an Effect at a Promise edge (boot, the `qwbe` commands, the pack-facing checker) on the
 * Node platform. A failure rejects with the original error, not a FiberFailure wrapper, so the
 * caller's `instanceof` and message checks keep working.
 */
export const runNode = <A, E>(effect: Effect.Effect<A, E, NodeContext.NodeContext>): Promise<A> =>
  Effect.runPromiseExit(Effect.provide(effect, NodeContext.layer)).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value
    throw Cause.squash(exit.cause)
  })
