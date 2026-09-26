import * as Command from "@effect/platform/Command"
import * as NodeContext from "@effect/platform-node/NodeContext"
import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { capture } from "./process.ts"

it.layer(NodeContext.layer)((it) => {
  it.effect("captures nonzero status and both output streams", () =>
    Effect.gen(function* () {
      const result = yield* capture(
        Command.make(process.execPath, "-e", 'console.log("out"); console.error("err"); process.exitCode = 7'),
      )
      expect(result).toEqual({ status: 7, stdout: "out\n", stderr: "err\n" })
    }),
  )
  it.effect("drains large stdout and stderr without blocking exit", () =>
    Effect.gen(function* () {
      const result = yield* capture(
        Command.make(
          process.execPath,
          "-e",
          'process.stdout.write("a".repeat(200000)); process.stderr.write("b".repeat(200000))',
        ),
      )
      expect(result).toEqual({ status: 0, stdout: "a".repeat(200000), stderr: "b".repeat(200000) })
    }),
  )
})
