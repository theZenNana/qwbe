import * as FileSystem from "@effect/platform/FileSystem"
import * as NodeContext from "@effect/platform-node/NodeContext"
import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { readConfig } from "./config.ts"

const valid = "version: 1\ndev:\n  api: 4500\n  web: 4510\nuntested: []\n"

const readYamlText = (text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = `${yield* fs.makeTempDirectoryScoped()}/qwbe.yaml`
    yield* fs.writeFileString(file, text)
    return yield* readConfig(file)
  })

const failureOf = (text: string) => Effect.flip(readYamlText(text)).pipe(Effect.map((error) => error.message))

it.layer(NodeContext.layer)("readConfig", (it) => {
  it.scoped("decodes a valid file", () =>
    Effect.gen(function* () {
      expect(yield* readYamlText(valid)).toEqual({ version: 1, dev: { api: 4500, web: 4510 }, untested: [] })
    }),
  )

  it.scoped("refuses an unknown key and names it", () =>
    Effect.gen(function* () {
      expect(yield* failureOf(`${valid}extra: 1\n`)).toMatch(/qwbe\.yaml: extra: .*value 1/)
    }),
  )

  it.scoped("refuses a duplicate key", () =>
    Effect.gen(function* () {
      expect(yield* failureOf(`${valid}version: 1\n`)).toMatch(/invalid YAML.*unique/i)
    }),
  )

  it.scoped("refuses a wrong value and names path and value", () =>
    Effect.gen(function* () {
      expect(yield* failureOf(valid.replace("4510", "'x'"))).toMatch(/dev\.web: .*value 'x'/)
    }),
  )

  it.effect("reads the repository's own qwbe.yaml", () =>
    Effect.gen(function* () {
      const config = yield* readConfig(new URL("../../qwbe.yaml", import.meta.url).pathname)
      expect(config.dev).toEqual({ api: 4500, web: 4510 })
    }),
  )
})
