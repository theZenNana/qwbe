import * as NodeContext from "@effect/platform-node/NodeContext"
import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { capture, captureLines } from "./process.ts"
import { commandName, withoutAllowScripts } from "./process-pure.ts"

it("names a command by the words before its first path operand", () => {
  expect(commandName(["npx", "--no-install", "secretlint", "a.ts", "src/b.ts"])).toBe("npx --no-install secretlint")
  expect(commandName(["npx", "biome", "check", "."])).toBe("npx biome check")
  expect(commandName(["npm", "--prefix", "core", "test"])).toBe("npm --prefix core test")
  expect(commandName(["gitleaks", "git", ".", "--log-opts=origin/main..HEAD"])).toBe("gitleaks git")
})

const node = (script: string) => [process.execPath, "-e", script] as const

it.layer(NodeContext.layer)("capture", (it) => {
  it.effect("returns a non-zero code with both streams", () =>
    Effect.gen(function* () {
      const result = yield* capture(node("console.log('out'); console.error('err'); process.exit(7)"), ".")
      expect(result).toEqual({ status: 7, stdout: "out\n", stderr: "err\n" })
    }),
  )

  it.effect("reads large output on both streams without a pipe stall", () =>
    Effect.gen(function* () {
      const result = yield* capture(
        node("process.stdout.write('a'.repeat(200000)); process.stderr.write('b'.repeat(200000))"),
        ".",
      )
      expect([result.status, result.stdout.length, result.stderr.length]).toEqual([0, 200000, 200000])
    }),
  )

  // A gate is never interactive: a child that reads stdin must see end-of-file, not wait on an
  // open pipe forever. Shells hand that to direct runs; the executor's default pipe never ends.
  it.effect("gives the child a stdin that ends", () =>
    Effect.gen(function* () {
      const result = yield* capture(node("process.stdin.resume().on('end', () => console.log('eof'))"), ".")
      expect(result).toEqual({ status: 0, stdout: "eof\n", stderr: "" })
    }),
  )

  it.effect("drops npm_config_allow_scripts in any case", () =>
    Effect.gen(function* () {
      process.env.NPM_CONFIG_ALLOW_SCRIPTS = "x"
      process.env.npm_config_allow_scripts = "x"
      const result = yield* capture(node("console.log(Object.keys(process.env).join(' '))"), ".")
      expect(result.stdout.toLowerCase()).not.toContain("npm_config_allow_scripts")
    }).pipe(
      // Files share a module graph now (no per-file isolation): leave the env as it was found.
      Effect.ensuring(
        Effect.sync(() => {
          delete process.env.NPM_CONFIG_ALLOW_SCRIPTS
          delete process.env.npm_config_allow_scripts
        }),
      ),
    ),
  )

  it("withoutAllowScripts unsets only the allow-scripts keys", () => {
    expect(withoutAllowScripts({ NPM_CONFIG_ALLOW_SCRIPTS: "x", PATH: "/bin" })).toEqual({
      NPM_CONFIG_ALLOW_SCRIPTS: undefined,
      PATH: "/bin",
    })
  })

  it.effect("captureLines fails with GateFailed on a non-zero code", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(captureLines(node("process.exit(3)"), "."))
      expect(error).toMatchObject({ _tag: "GateFailed", status: 3 })
    }),
  )
})
