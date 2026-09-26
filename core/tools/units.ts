import type { PlatformError } from "@effect/platform/Error"
import * as FileSystem from "@effect/platform/FileSystem"
import * as Path from "@effect/platform/Path"
import * as Effect from "effect/Effect"

// A unit is a directory the kernel mounts or owns: every cube, every space, the kernel's own
// subsystems and every cube of an installed pack.
const OWN = ["core/src/kernel", "core/src/pg", "core/src/metadata", "core/src/host"]
const PARENTS = ["core/src/cubes", "core/src/spaces"]
const PACK_HOLDERS = ["core/plugins", "core/store"]

// A missing directory holds no units; any other read error is real and fails the gate.
const missing = (error: PlatformError) => error._tag === "SystemError" && error.reason === "NotFound"

const subdirs = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const names = yield* fs.readDirectory(dir).pipe(Effect.catchIf(missing, () => Effect.succeed<string[]>([])))
    const dirs = names.filter((name) => !name.startsWith(".")).map((name) => path.join(dir, name))
    return yield* Effect.filter(dirs, (full) => fs.stat(full).pipe(Effect.map((info) => info.type === "Directory")))
  })

/** Every unit under `root`, as sorted repo-relative paths with forward slashes. */
export const units = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const found = yield* Effect.filter(
      OWN.map((dir) => path.join(root, dir)),
      (dir) => fs.exists(dir),
    )
    for (const parent of PARENTS) found.push(...(yield* subdirs(path.join(root, parent))))
    for (const holder of PACK_HOLDERS)
      for (const pack of yield* subdirs(path.join(root, holder)))
        found.push(...(yield* subdirs(path.join(pack, "cubes"))))
    return found.map((dir) => path.relative(root, dir).split(path.sep).join("/")).sort()
  })
