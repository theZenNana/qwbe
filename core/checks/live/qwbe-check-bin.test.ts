import { join } from "node:path"
import * as Command from "@effect/platform/Command"
import * as FileSystem from "@effect/platform/FileSystem"
import * as NodeContext from "@effect/platform-node/NodeContext"
import { expect, layer } from "@effect/vitest"
import * as Console from "effect/Console"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { CORE } from "../_layers/workspace.ts"

// The real `qwbe check` bin, run as a process against a pack in a temp directory. The pack gets
// qwbe-core "installed" the way the npm pack tarball lands: real directories, node_modules linked
// to the real one. The stage rules are proven in src/check-package.test.ts; this proves the command.
// Stage 3 boots the kernel over a throwaway Postgres database, so this check needs Postgres.

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

const GREEN_PROBE = `const base = process.env.QWBE_URL
const reply = await fetch(base + "/openapi.json")
process.exit(reply.status === 200 || reply.status === 401 ? 0 : 1)
`

const RED_PROBE = "process.exit(1)\n"

const manifest = (name: string) => JSON.stringify({ name, kind: "plugin", cubes: ["gadgets"] })

const packageJson = (name: string) =>
  JSON.stringify({
    name,
    private: true,
    type: "module",
    scripts: { test: "qwbe check ." },
    dependencies: { "qwbe-core": "0.0.0" },
  })

/** The kernel as a tarball install would leave it under the pack's node_modules. */
const installKernel = (pack: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dest = join(pack, "node_modules", "qwbe-core")
    yield* fs.makeDirectory(dest, { recursive: true })
    for (const entry of ["bin", "src", "package.json", "qwbe.config.json"]) {
      yield* fs.copy(join(CORE, entry), join(dest, entry))
    }
    yield* fs.symlink(join(CORE, "node_modules"), join(dest, "node_modules"))
  })

/** One pack with the gadgets cube and the given probe, in a scoped temp directory. */
const makePack = (name: string, probe: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pack = join(yield* fs.makeTempDirectoryScoped({ prefix: "qwbe-check-bin-" }), name)
    yield* fs.makeDirectory(join(pack, "cubes", "gadgets"), { recursive: true })
    yield* fs.makeDirectory(join(pack, "probes"))
    yield* fs.writeFileString(join(pack, "qwbe-package.json"), manifest(name))
    yield* fs.writeFileString(join(pack, "package.json"), packageJson(name))
    yield* fs.writeFileString(join(pack, "cubes", "gadgets", "index.ts"), CUBE)
    yield* fs.writeFileString(join(pack, "probes", "selfcheck.mjs"), probe)
    yield* installKernel(pack)
    return pack
  })

/** `qwbe check <pack>`: exit code, stdout and stderr; the total duration is the bench line. */
const runCheck = (pack: string) =>
  Effect.gen(function* () {
    const proc = yield* Command.start(Command.make(process.execPath, BIN, "check", pack))
    const text = (stream: typeof proc.stdout) => stream.pipe(Stream.decodeText(), Stream.mkString)
    const [stdout, stderr, exitCode] = yield* Effect.all([text(proc.stdout), text(proc.stderr), proc.exitCode], {
      concurrency: 3,
    })
    return { stdout, stderr, exitCode: Number(exitCode) }
  }).pipe(
    Effect.timed,
    Effect.tap(([elapsed]) => Console.log(`bench qwbe-check-bin: ${Math.round(Duration.toMillis(elapsed))} ms`)),
    Effect.map(([, result]) => result),
  )

layer(NodeContext.layer, { timeout: 240_000, excludeTestServices: true })((it) => {
  it.scoped("a clean pack passes all four stages with exit 0", () =>
    Effect.gen(function* () {
      const { stdout, stderr, exitCode } = yield* runCheck(yield* makePack("good-pack", GREEN_PROBE))
      expect(exitCode, stdout + stderr).toBe(0)
      expect(stdout).toContain("qwbe check: PASS")
      expect(stdout).toMatch(/\[1\/4\] source: ok/)
      expect(stdout).toMatch(/\[2\/4\] caps: ok/)
      expect(stdout).toMatch(/\[3\/4\] runtime: kernel booted at http:\/\/127\.0\.0\.1:\d+;.*selfcheck\.mjs exit 0/)
      expect(stdout).toMatch(/\[4\/4\] invocation: ok/)
    }),
  )

  it.scoped("a red probe fails stage runtime with exit 1 and is named", () =>
    Effect.gen(function* () {
      const { stdout, stderr, exitCode } = yield* runCheck(yield* makePack("red-probe-pack", RED_PROBE))
      expect(exitCode, stdout + stderr).toBe(1)
      expect(stdout).toContain("FAIL (stage runtime)")
      expect(stdout).toContain("probes/selfcheck.mjs")
    }),
  )
})
