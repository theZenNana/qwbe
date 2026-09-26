import * as FileSystem from "@effect/platform/FileSystem"
import * as NodeContext from "@effect/platform-node/NodeContext"
import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Either from "effect/Either"
import { loadConfig } from "./config.ts"

const BENCH =
  "bench:\n  list60k: { deepPageFloorMs: 250, deepPageFactor: 4, anyAnswerMs: 1000 }\n  stagingImport: { minRowsPerSecond: 1000 }\n"
const valid = `version: 1\ndev:\n  api: 4500\n  web: 4510\nuntested: []\n${BENCH}`
it.layer(NodeContext.layer)((it) => {
  for (const [name, text, detail] of [
    ["unknown key", `${valid}surprise: true\n`, "surprise"],
    ["duplicate key", `${valid}version: 1\n`, "version"],
    ["wrong value", valid.replace("4500", "70000"), "70000"],
    ["nested unknown key", valid.replace("  api:", "  extra: 1\n  api:"), "extra"],
  ]) {
    it.scoped(`rejects ${name} with file and offending value`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const file = `${dir}/qwbe.yaml`
        yield* fs.writeFileString(file, text!)
        const result = yield* Effect.either(loadConfig(file))
        expect(Either.isLeft(result)).toBe(true)
        if (Either.isLeft(result)) {
          expect(result.left._tag).toBe("ConfigInvalid")
          expect(result.left.message).toContain(file)
          expect(result.left.message).toContain(detail)
        }
      }),
    )
  }
  it.scoped("loads ports and the untested list", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${dir}/qwbe.yaml`, valid)
      expect(yield* loadConfig(`${dir}/qwbe.yaml`)).toMatchObject({
        version: 1,
        dev: { api: 4500, web: 4510 },
        untested: [],
      })
    }),
  )
})
