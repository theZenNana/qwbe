import { join, relative, sep } from "node:path"
import * as Effect from "effect/Effect"
import { existing, subdirs } from "./dirs.ts"

// A unit is a directory the kernel mounts or owns: every cube, every space, the kernel's own
// subsystems and every cube of an installed pack.
const OWN = ["core/src/kernel", "core/src/pg", "core/src/metadata", "core/src/host"]
const PARENTS = ["core/src/cubes", "core/src/spaces"]
const PACK_HOLDERS = ["core/plugins", "core/store"]

const childrenOf = (root: string, parents: ReadonlyArray<string>) =>
  Effect.forEach(parents, (parent) => subdirs(join(root, parent))).pipe(Effect.map((lists) => lists.flat()))

const packCubes = (root: string) =>
  childrenOf(root, PACK_HOLDERS).pipe(
    Effect.flatMap((packs) => Effect.forEach(packs, (pack) => subdirs(join(pack, "cubes")))),
    Effect.map((lists) => lists.flat()),
  )

/** Pure: `dirs` as sorted repo-relative ids with forward slashes. */
export const unitIds = (root: string, dirs: ReadonlyArray<string>) =>
  dirs.map((dir) => relative(root, dir).split(sep).join("/")).sort()

/** Every unit under `root`, as sorted repo-relative ids. */
export const units = (root: string) =>
  Effect.all([existing(OWN.map((dir) => join(root, dir))), childrenOf(root, PARENTS), packCubes(root)]).pipe(
    Effect.map((groups) => unitIds(root, groups.flat())),
  )
