import * as Path from "@effect/platform/Path"
import * as Effect from "effect/Effect"
import { IS_TEST, walk } from "../src/package-size.ts"
import { units } from "./units.ts"

/** Units with source files and no test file, minus the `excused` ids. */
export const untested = (root: string, excused: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    return (yield* units(root)).filter((id) => {
      if (excused.includes(id)) return false
      const files = walk(path.join(root, id), { includeTests: true })
      const tests = files.filter((file) => IS_TEST.test(path.basename(file)))
      return files.length > tests.length && tests.length === 0
    })
  })
