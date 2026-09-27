import * as FileSystem from "@effect/platform/FileSystem"
import * as NodeContext from "@effect/platform-node/NodeContext"
import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { flagsFrom } from "./args.ts"
import { GATES, gateList } from "./gates.ts"
import { capture } from "./process.ts"
import { exitCodeFor, runGates } from "./run-gates.ts"
import { gateFindings } from "./steps.ts"

// The last script writes a marker, so its presence proves the run went past the red gate.
const fakePackage = {
  name: "fake",
  private: true,
  scripts: {
    green: "node -e 0",
    red: "node -e process.exit(3)",
    last: "node -e \"require('fs').writeFileSync('last-ran', '')\"",
  },
}

it.layer(NodeContext.layer)("runGates", (it) => {
  it.scoped("runs every gate and one red gate gives exit 1", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${root}/package.json`, JSON.stringify(fakePackage))
      const failed = yield* runGates(
        ["green", "red", "last"].map((script) => ({
          name: script,
          findings: gateFindings(root, [], [["npm", "run", script]]),
        })),
      )
      expect([failed, exitCodeFor(failed), yield* fs.exists(`${root}/last-ran`)]).toEqual([1, 1, true])
    }),
  )

  it.effect("all green gives exit 0", () =>
    Effect.gen(function* () {
      const failed = yield* runGates([{ name: "empty", findings: Effect.succeed([]) }])
      expect(exitCodeFor(failed)).toBe(0)
    }),
  )

  it.effect("--live and --bench each append one gate; plain check keeps the list unchanged", () =>
    Effect.gen(function* () {
      const flags = yield* flagsFrom(["--bench", "--live"])
      expect(gateList(false, false)).toEqual(GATES)
      expect(gateList(flags.live, flags.bench).map(({ name }) => name)).toEqual([
        ...GATES.map(({ name }) => name),
        "live",
        "bench",
      ])
    }),
  )

  it.effect("check refuses an unknown argument before any gate runs", () =>
    Effect.gen(function* () {
      const check = new URL("./check.ts", import.meta.url).pathname
      const result = yield* capture([process.execPath, check, "--bogus"], ".")
      expect([result.status, result.stdout, result.stderr]).toEqual([1, "", expect.stringContaining("--bogus")])
    }),
  )
})
