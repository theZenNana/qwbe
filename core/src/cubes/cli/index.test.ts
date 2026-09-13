// QWB-69: unit tests for the cli cube. Proves the manifest contract (runsCommands privilege,
// route permissions) and the gate behavior over the real handlers with a stubbed kernel
// dispatcher: empty input, unknown commands and per-caller permission filtering.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Effect } from "effect"
import type { CubeTools } from "qwbe-core/cube"
import { CurrentUser } from "../../kernel/auth-contract.ts"
import { BadRequest, Forbidden } from "../../kernel/errors.ts"
import type { CommandRunner, CommandSpec } from "../../kernel/manifest.ts"
import { routeContracts } from "../../metadata/metadata.ts"
import { baseTools, currentUser } from "../../test-cube-tools.ts"
import { cube } from "./index.ts"

// The routes the kernel actually publishes, derived the one way (entity-less cube: no field
// metadata, so deriveCubeMetadata never reaches the routes -- routeContracts is that derivation).
const md = routeContracts(
  cube.manifest.name,
  cube.create({ store: {}, bus: { publish: () => undefined as never }, runCommands: {} } as never).group,
  cube.manifest,
)

const cliTools = (
  invoke: NonNullable<CommandRunner>["invoke"],
  commands: ReadonlyArray<CommandSpec> = [],
): CubeTools => {
  const tools = baseTools() as Record<string, unknown>
  tools.runCommands = { invoke }
  tools.commands = () => commands
  return tools as CubeTools
}

// Stub dispatcher mimicking kernel behavior: succeeds only for a declared command
// ("cli:help"), fails with the real `UnknownCommand` refusal for anything else.
const okInvoke: NonNullable<CommandRunner>["invoke"] = (name, _args, _perms) =>
  name === "cli:help"
    ? Effect.succeed({ command: name, output: `ran ${name}`, ok: true })
    : Effect.fail({ _tag: "UnknownCommand" })

const runExec = (line: string, permissions: ReadonlyArray<string> = ["cli:exec"]) => {
  const p = cube.create(cliTools(okInvoke))
  return Effect.provideService(
    (
      p.handlers.exec as (a: {
        payload: { line: string }
      }) => Effect.Effect<unknown, BadRequest | Forbidden, CurrentUser>
    )({
      payload: { line },
    }),
    CurrentUser,
    currentUser({ roles: ["admin"], permissions }),
  )
}

describe("cli cube contract (QWB-69)", () => {
  it("publishes the dispatcher privilege and its route demands through the kernel's one derivation", () => {
    assert.equal(cube.manifest.name, "cli")
    assert.equal(cube.manifest.requiresAuth, true)
    assert.equal(cube.manifest.runsCommands, true)
    assert.deepEqual(cube.manifest.tables, [])
    assert.deepEqual(md, {
      commands: { auth: true, permission: "cli:read", method: "GET", path: "/cli/commands" },
      exec: { auth: true, permission: "cli:exec", method: "POST", path: "/cli/exec" },
    })
  })

  it("refuses to mount without the kernel dispatcher", () => {
    // The manifest asks for runsCommands; a missing dispatcher is a kernel bug that must
    // fail at startup, not a 500 on the first command.
    assert.throws(() => cube.create(baseTools()))
  })
})

describe("cli exec gate (QWB-69)", () => {
  it("refuses an empty command with BadRequest", async () => {
    const err = await Effect.runPromise(Effect.flip(runExec("   ")))
    assert.ok(err instanceof BadRequest)
    assert.equal(err.message, "empty command")
  })

  it("refuses an unknown command without running anything", async () => {
    const err = await Effect.runPromise(Effect.flip(runExec("definitely-not-a-command")))
    assert.ok(err instanceof BadRequest)
    assert.match(err.message, /unknown command/)
  })

  it("refuses a caller without cli:exec even for a known command", async () => {
    const err = await Effect.runPromise(Effect.flip(runExec("cli:help", [])))
    assert.ok(err instanceof Forbidden)
    assert.equal((err as Forbidden).needed, "cli:exec")
  })

  it("dispatches a declared command to the kernel with the caller's permissions", async () => {
    const result = await Effect.runPromise(runExec("cli:help"))
    assert.deepEqual(result, { command: "cli:help", output: "ran cli:help", ok: true })
  })

  it("marks each listed command allowed or not, per the caller's permissions", async () => {
    const commands: ReadonlyArray<CommandSpec> = [
      { name: "a", summary: "allowed one", permission: "cli:read", run: () => Effect.succeed("a") },
      { name: "b", summary: "denied one", permission: "settings:write", run: () => Effect.succeed("b") },
    ]
    const p = cube.create(cliTools(okInvoke, commands))
    const run = p.handlers.commands as unknown as () => Effect.Effect<unknown, never, CurrentUser>
    const out = (await Effect.runPromise(
      Effect.provideService(run(), CurrentUser, currentUser({ permissions: ["cli:read"] })),
    )) as ReadonlyArray<{ name: string; permission: string; allowed: boolean }>
    // Per-caller marking: `a` (cli:read) allowed, `b` (settings:write) not.
    assert.deepEqual(
      out.map((c) => ({ name: c.name, allowed: c.allowed })),
      [
        { name: "a", allowed: true },
        { name: "b", allowed: false },
      ],
    )
    // The full listing still carries what the UI renders; only the flag is per caller.
    assert.deepEqual(out[0]!.permission, "cli:read")
    assert.deepEqual(out[1]!.permission, "settings:write")
  })
})
