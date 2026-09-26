import * as FileSystem from "@effect/platform/FileSystem"
import * as NodeContext from "@effect/platform-node/NodeContext"
import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { untested } from "./testgate.ts"

it.layer(NodeContext.layer)((it) => {
  it.scoped("fails a unit without tests unless it is excused", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped()
      const file = (rel: string) =>
        fs
          .makeDirectory(`${root}/${rel.slice(0, rel.lastIndexOf("/"))}`, { recursive: true })
          .pipe(Effect.andThen(fs.writeFileString(`${root}/${rel}`, "export {}\n")))
      yield* file("core/src/cubes/tested/index.ts")
      yield* file("core/src/cubes/tested/index.test.ts")
      yield* file("core/src/cubes/bare/index.ts")
      yield* file("core/plugins/pack/cubes/debt/index.ts")
      yield* file("core/src/kernel/state.ts")

      expect(yield* untested(root, ["core/plugins/pack/cubes/debt"])).toEqual([
        "core/src/cubes/bare",
        "core/src/kernel",
      ])
      expect(yield* untested(root, [])).toContain("core/plugins/pack/cubes/debt")
    }),
  )
})
