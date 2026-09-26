import { join } from "node:path"
import * as Effect from "effect/Effect"
import { walk } from "../src/package-size.ts"
import { lacksTests } from "./test-files.ts"
import { units } from "./units.ts"

const filesOf = (dir: string) => Effect.sync(() => walk(dir, { includeTests: true }))

/** Units with source files and no test file, minus the `excused` ids. */
export const untested = (root: string, excused: ReadonlyArray<string>) =>
  units(root).pipe(
    Effect.map((ids) => ids.filter((id) => !excused.includes(id))),
    Effect.flatMap((ids) => Effect.filter(ids, (id) => filesOf(join(root, id)).pipe(Effect.map(lacksTests)))),
  )
