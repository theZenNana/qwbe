// The one fixture pack the unit tests write: a manifest plus one file per declared cube,
// plus whatever extra paths the test needs. Tests that need a BROKEN package mutate the
// returned tree afterwards -- the helper only writes the passing shape.

import { dirname, join } from "node:path"
import { FileSystem } from "@effect/platform"
import { Effect } from "effect"
import { runNode } from "./files.ts"

export const writePack = (
  dir: string,
  { name, cubes, extra }: { name: string; cubes: Record<string, string>; extra?: Record<string, string> },
): Promise<string> =>
  runNode(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const files: Record<string, string> = {
        "qwbe-package.json": JSON.stringify({ name, kind: "plugin", cubes: Object.keys(cubes) }),
        ...Object.fromEntries(Object.entries(cubes).map(([cube, source]) => [join("cubes", cube, "index.ts"), source])),
        ...extra,
      }
      for (const [rel, body] of Object.entries(files)) {
        yield* fs.makeDirectory(dirname(join(dir, rel)), { recursive: true })
        yield* fs.writeFileString(join(dir, rel), body)
      }
      return dir
    }),
  )
