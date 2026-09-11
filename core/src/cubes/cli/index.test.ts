// QWB-69: unit tests for the cli cube. Proves the manifest contract (runsCommands privilege,
// route permissions) and the gate behavior over the real handlers with a stubbed kernel
// dispatcher: empty input, unknown commands and per-caller permission filtering.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Effect } from "effect"
import type { CubeTools } from "qwbe-core/cube"
import { CurrentUser } from "../../kernel/auth-contract.ts"
import { BadRequest, Forbidden } from "../../kernel/errors.ts"
import { baseTools } from "../../testing.ts"
import { cube } from "./index.ts"

const user = (permissions: ReadonlyArray<string>) => ({
  id: "acc-1",
  username: "ana",
  roles: ["admin"],
  permissions,
  sessionId: "ses-1",
})

const cliTools = (invoke: never): CubeTools => {
  const tools = baseTools() as Record<string, unknown>
  tools.runCommands = { invoke }
  return tools as unknown as CubeTools
}

// Stub dispatcher mimicking kernel behavior: succeeds only for a declared command
// ("cli:help"), fails with the `UnknownCommand` tag for anything else.
const okInvoke = (name: string, _args: ReadonlyArray<string>, _perms: ReadonlyArray<string>) =>
  name === "cli:help" ? Effect.succeed(`ran ${name}`) : Effect.fail({ _tag: "UnknownCommand" } as never)

const runExec = (line: string, permissions: ReadonlyArray<string> = ["cli:exec"]) => {
  const p = cube.create(cliTools(okInvoke as never))
  return Effect.provideService(
    (
      p.handlers.exec as (a: {
        payload: { line: string }
      }) => Effect.Effect<unknown, BadRequest | Forbidden, CurrentUser>
    )({
      payload: { line },
    }),
    CurrentUser,
    user(permissions),
  )
}

describe("cli cube contract (QWB-69)", () => {
  it("declares the dispatcher privilege and its route permissions", () => {
    assert.equal(cube.manifest.name, "cli")
    assert.equal(cube.manifest.requiresAuth, true)
    assert.equal(cube.manifest.runsCommands, true)
    assert.deepEqual(cube.manifest.tables, [])
    const routes = cube.manifest.routes as Record<string, string>
    assert.deepEqual(routes, { commands: "cli:read", exec: "cli:exec" })
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
    assert.equal(result, "ran cli:help")
  })
})
