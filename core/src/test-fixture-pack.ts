// The one fixture pack the unit tests write: a manifest plus one file per declared cube,
// plus whatever extra paths the test needs. Tests that need a BROKEN package mutate the
// returned tree afterwards -- the helper only writes the passing shape.

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export const writePack = (
  dir: string,
  { name, cubes, extra }: { name: string; cubes: Record<string, string>; extra?: Record<string, string> },
): string => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "qwbe-package.json"), JSON.stringify({ name, kind: "plugin", cubes: Object.keys(cubes) }))
  for (const [cube, source] of Object.entries(cubes)) {
    mkdirSync(dirname(join(dir, "cubes", cube, "index.ts")), { recursive: true })
    writeFileSync(join(dir, "cubes", cube, "index.ts"), source)
  }
  for (const [rel, body] of Object.entries(extra ?? {})) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  return dir
}
