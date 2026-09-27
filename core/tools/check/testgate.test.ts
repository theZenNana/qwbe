import * as FileSystem from "@effect/platform/FileSystem"
import * as NodeContext from "@effect/platform-node/NodeContext"
import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { testgate } from "./testgate.ts"

const files = [
  "core/src/cubes/tested/index.ts",
  "core/src/cubes/tested/index.test.ts",
  "core/src/cubes/bare/index.ts",
  "core/plugins/pack/cubes/listed/index.ts",
  "core/src/kernel/scan.ts",
  "core/src/kernel/scan.test.ts",
]

const plantedRoot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped()
  for (const file of files) {
    yield* fs.makeDirectory(`${root}/${file.slice(0, file.lastIndexOf("/"))}`, { recursive: true })
    yield* fs.writeFileString(`${root}/${file}`, "export {}\n")
  }
  return root
})

it.layer(NodeContext.layer)("testgate", (it) => {
  it.scoped("a cube without a test fails and a listed cube passes", () =>
    Effect.gen(function* () {
      const root = yield* plantedRoot
      expect(yield* testgate(root, ["core/plugins/pack/cubes/listed"])).toEqual(["core/src/cubes/bare"])
    }),
  )

  it.scoped("with an empty list (strict) the listed cube fails too", () =>
    Effect.gen(function* () {
      const root = yield* plantedRoot
      expect(yield* testgate(root, [])).toEqual(["core/src/cubes/bare", "core/plugins/pack/cubes/listed"])
    }),
  )
})
