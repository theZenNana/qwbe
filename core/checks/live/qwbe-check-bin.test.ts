import { dirname, join } from "node:path"
import * as FileSystem from "@effect/platform/FileSystem"
import * as NodeContext from "@effect/platform-node/NodeContext"
import { expect, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { capture } from "../../tools/shared/process.ts"
import { CORE } from "../_layers/workspace.ts"

// Replaces probes/check-command.mjs: the real `qwbe check` bin, run as a process against a pack
// in a temp directory, one green and one red. The stage rules are proven in
// src/check-package.test.ts; this proves the command. Stage 3 boots the kernel over a throwaway
// Postgres database, so this check needs Postgres.

const BIN = join(CORE, "bin", "qwbe.mjs")

const CUBE = `import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization } from "qwbe-core/auth"
import { type CubeTools, defineCube } from "qwbe-core/cube"
import { Forbidden } from "qwbe-core/errors"

const group = HttpApiGroup.make("gadgets")
  .add(HttpApiEndpoint.get("list")\`/gadgets\`.addSuccess(Schema.Array(Schema.String)).addError(Forbidden))
  .middleware(Authorization)

export const cube = defineCube(group, {
  manifest: { name: "gadgets", tables: [], requiresAuth: true, permissions: [{ name: "gadgets:read", roles: ["admin"] }] },
  create: (_tools: CubeTools) => ({ handlers: { list: () => Effect.succeed(["wrench"]) } }),
})
`

// Logs in to the kernel qwbe check booted (QWBE_URL is the contract) and finds its own cube.
const GREEN_PROBE = `const base = process.env.QWBE_URL
const login = await fetch(base + "/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: process.env.QWBE_ADMIN_PASSWORD ?? "admin" }),
})
const { token } = await login.json()
const cubes = await fetch(base + "/settings/cubes", { headers: { authorization: "Bearer " + token } })
process.exit((await cubes.json()).some((cube) => cube.name === "gadgets") ? 0 : 1)
`

const RED_PROBE = "process.exit(1)\n"

// dist/ goes along when a build exists: an installed kernel runs the compiled files.
const KERNEL_FILES = ["bin", "src", "dist", "package.json", "qwbe.config.json"]

/** Pure: every file of a pack named `name` with the gadgets cube and `probe` as its one probe. */
const packFiles = (name: string, probe: string): ReadonlyArray<readonly [path: string, text: string]> => [
  ["qwbe-package.json", JSON.stringify({ name, kind: "plugin", cubes: ["gadgets"] })],
  [
    "package.json",
    JSON.stringify({
      name,
      private: true,
      type: "module",
      scripts: { test: "qwbe check ." },
      dependencies: { "qwbe-core": "0.0.0" },
    }),
  ],
  ["cubes/gadgets/index.ts", CUBE],
  ["probes/selfcheck.mjs", probe],
]

/** The kernel as the npm pack tarball lands it: real directories, node_modules linked to the real one. */
const installKernel = (pack: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dest = join(pack, "node_modules", "qwbe-core")
    yield* fs.makeDirectory(dest, { recursive: true })
    for (const entry of KERNEL_FILES) {
      if (yield* fs.exists(join(CORE, entry))) yield* fs.copy(join(CORE, entry), join(dest, entry))
    }
    yield* fs.symlink(join(CORE, "node_modules"), join(dest, "node_modules"))
  })

const writeFiles = (dir: string, files: ReadonlyArray<readonly [path: string, text: string]>) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    Effect.forEach(
      files,
      ([path, text]) =>
        fs
          .makeDirectory(dirname(join(dir, path)), { recursive: true })
          .pipe(Effect.zipRight(fs.writeFileString(join(dir, path), text))),
      { discard: true },
    ),
  )

/** The pack in a scoped temp directory, with the kernel installed under its node_modules. */
const makePack = (name: string, probe: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pack = join(yield* fs.makeTempDirectoryScoped({ prefix: "qwbe-check-bin-" }), name)
    yield* writeFiles(pack, packFiles(name, probe))
    yield* installKernel(pack)
    return pack
  })

// The bin boots its kernel from a sandbox under core/; a finished run leaves none behind.
const leftSandboxes = Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readDirectory(CORE)).pipe(
  Effect.map((entries) => entries.filter((entry) => entry.startsWith(".qwbe-check-"))),
)

// A timeout kills the bin before its own finally runs, so the test's scope removes the sandboxes
// this run made; the next test then judges its own run, not this one's leftovers.
const removeNewSandboxesOnClose = (before: ReadonlyArray<string>) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    Effect.addFinalizer(() =>
      leftSandboxes.pipe(
        Effect.flatMap((after) =>
          Effect.forEach(
            after.filter((entry) => !before.includes(entry)),
            (entry) => fs.remove(join(CORE, entry), { recursive: true }),
          ),
        ),
        Effect.orDie,
      ),
    ),
  )

const runCheck = (pack: string) =>
  Effect.flatMap(leftSandboxes, removeNewSandboxesOnClose).pipe(
    Effect.zipRight(capture([process.execPath, BIN, "check", pack], CORE).pipe(Effect.timeout("150 seconds"))),
  )

layer(NodeContext.layer, { timeout: 180_000, excludeTestServices: true })((it) => {
  it.scoped("a clean pack passes all four stages with exit 0", () =>
    Effect.gen(function* () {
      const { status, stdout, stderr } = yield* runCheck(yield* makePack("good-pack", GREEN_PROBE))
      expect(status, stdout + stderr).toBe(0)
      expect(stdout).toMatch(
        /\[1\/4\] source: ok\n.*\[2\/4\] caps: ok\n.*\[3\/4\] runtime: .*selfcheck\.mjs exit 0\n.*\[4\/4\] invocation: ok\n.*qwbe check: PASS/,
      )
      expect(yield* leftSandboxes).toEqual([])
    }),
  )

  it.scoped("a red probe fails stage runtime with exit 1 and is named", () =>
    Effect.gen(function* () {
      const { status, stdout, stderr } = yield* runCheck(yield* makePack("red-probe-pack", RED_PROBE))
      expect(status, stdout + stderr).toBe(1)
      expect(stdout).toContain("qwbe check: FAIL (stage runtime)")
      expect(stdout).toContain("selfcheck.mjs")
      expect(yield* leftSandboxes).toEqual([])
    }),
  )
})
