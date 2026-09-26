import * as NodeContext from "@effect/platform-node/NodeContext"
import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { commands, runGates } from "./gate.ts"

it.layer(NodeContext.layer)((it) => {
  it.effect("runs every gate and returns only the red ones", () =>
    Effect.gen(function* () {
      const red = yield* runGates([
        { name: "red first", problems: Effect.succeed(["broken"]) },
        { name: "green after red", problems: Effect.succeed([]) },
        { name: "red last", problems: Effect.succeed(["also broken"]) },
      ])
      expect(red).toEqual(["red first", "red last"])
    }),
  )

  it.effect("turns a nonzero exit or a missing binary into problems", () =>
    Effect.gen(function* () {
      const cwd = import.meta.dirname
      expect(yield* commands(cwd, [process.execPath, "-e", "process.exit(0)"])).toEqual([])
      const failed = yield* commands(cwd, [process.execPath, "-e", 'console.log("why"); process.exit(3)'])
      expect(failed[0]).toContain("exited 3")
      expect(failed).toContain("why")
      expect(yield* commands(cwd, ["no-such-binary-qwbe"])).toHaveLength(1)
    }),
  )
})
