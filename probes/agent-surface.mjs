// End-to-end proof for the GENERIC agent surface -- the kernel half of the plugin contract,
// with no plugin name in it:
//
//   1. a cube declaring `agent: true` without the four contract routes is refused at mount;
//   2. the same cube, completed with the generic surface, mounts and answers it;
//   3. the system boots and serves with NO agent plugin on disk at all.
//
// Both fixture plugins live only in a scratch copy of core/plugins for the duration of the
// run. The pilot plugin with its real runtime moved out of the repository on QWB-28
// (qwbe-packs/plugins/activegraph) and carries its own probe pair; this one covers what
// every agent plugin gets -- and what happens when there is none.

import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { client, coreDir, dropScratch, freePort, makeScore, scratchDataDir, startServer, stopServer } from "./lib.mjs"

const realPlugins = join(coreDir, "plugins")
const stash = mkdtempSync(join(tmpdir(), "qwbe-plugins-stash-"))
const stashDir = join(stash, "plugins")
const score = makeScore()

// Move the real plugins aside, work in an empty plugins directory, restore in `finally`.
// The server reads plugins from disk at boot, so a fixture plugin is a directory, not a mock.
// Every mounted plugin goes aside, not just example-plugin: after an install-from (QWB-29)
// the installed copy lives here too, and "no plugin on disk" must keep meaning it.
cpSync(realPlugins, stashDir, { recursive: true })
for (const entry of readdirSync(realPlugins)) {
  rmSync(join(realPlugins, entry), { recursive: true, force: true })
}

const restore = () => {
  cpSync(stashDir, realPlugins, { recursive: true })
  rmSync(stash, { recursive: true, force: true })
}

const BROKEN_CUBE = `import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { defineCube } from "qwbe-core/cube"
import { Authorization } from "../../../../src/kernel/auth-contract.ts"

const group = HttpApiGroup.make("fakeagent")
  .add(HttpApiEndpoint.get("health")\`/fakeagent/health\`)
  .middleware(Authorization)

export const cube = defineCube(group, {
  manifest: { name: "fakeagent", tables: [], agent: true, requiresAuth: true },
  create: () => ({ handlers: { health: () => ({ ok: true }) } }),
})
`

const GENERIC_HANDLERS = `import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { Effect } from "effect"
import { AgentContext, AgentGoalPayload, AgentGoalResult, AgentHealth, AgentTrace } from "qwbe-core/agent"
import { defineCube } from "qwbe-core/cube"
import { Authorization } from "../../../../src/kernel/auth-contract.ts"

const group = HttpApiGroup.make("fakeagent")
  .add(HttpApiEndpoint.get("health")\`/fakeagent/health\`.addSuccess(AgentHealth))
  .add(HttpApiEndpoint.get("context")\`/fakeagent/context\`.addSuccess(AgentContext))
  .add(HttpApiEndpoint.post("goal")\`/fakeagent/goals\`.setPayload(AgentGoalPayload).addSuccess(AgentGoalResult))
  .add(HttpApiEndpoint.get("trace")\`/fakeagent/trace\`.addSuccess(AgentTrace))
  .middleware(Authorization)

export const cube = defineCube(group, {
  manifest: {
    name: "fakeagent",
    tables: [],
    agent: true,
    requiresAuth: true,
    permissions: [{ name: "fakeagent:read", roles: ["admin"] }],
  },
  create: () => ({
    handlers: {
      health: () => Effect.succeed({ cube: "fakeagent", state: "ready" as const, runtime: "fake 0.0.1" }),
      context: () => Effect.succeed({ cube: "fakeagent", allowed: ["/fakeagent/health"], crossCube: false }),
      goal: ({ payload }: { payload: typeof AgentGoalPayload.Type }) =>
        Effect.succeed({ cube: "fakeagent", state: "idle", goal: payload.goal, answer: "no runtime here" }),
      trace: () => Effect.succeed({ cube: "fakeagent", runId: null, state: "empty", events: [] }),
    },
  }),
})
`

const writeFixture = (source) => {
  const dir = join(realPlugins, "fakeagent-plugin", "cubes", "fakeagent")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(realPlugins, "fakeagent-plugin", "qwbe-package.json"),
    JSON.stringify({ name: "fakeagent-plugin", kind: "plugin", cubes: ["fakeagent"] }),
  )
  writeFileSync(join(dir, "index.ts"), source)
}

const dropFixture = () => rmSync(join(realPlugins, "fakeagent-plugin"), { recursive: true, force: true })

try {
  // --- 1. the gate refuses an incomplete declaration -----------------------------------------
  {
    writeFixture(BROKEN_CUBE)

    const port = await freePort()
    const data = scratchDataDir("agent-gate")
    const server = await startServer(port, { QWBE_DATA_DIR: data })
    score.check(
      "a cube declaring agent: true without the four routes is refused at mount",
      !server.alive && /declares agent: true but does not serve the generic agent surface/.test(server.output),
      server.alive ? "server started -- the gate did not fire" : "refused",
    )
    await stopServer(server)
    dropFixture()
    dropScratch(data)
  }

  // --- 2. the same cube, completed, mounts and answers the generic surface --------------------
  {
    writeFixture(GENERIC_HANDLERS)

    const port = await freePort()
    const data = scratchDataDir("agent-surface")
    const api = client(port)
    const server = await startServer(port, { QWBE_DATA_DIR: data })
    if (!server.alive) {
      score.check("a complete agent cube mounts", false, server.output)
    } else {
      const admin = await api.login()
      const cubes = await api.call("/settings/cubes", { headers: admin.headers })
      const fake = cubes.body?.find?.((cube) => cube.name === "fakeagent")
      score.check("a complete agent cube mounts and publishes the capability", fake?.agent === true)

      const health = await api.call("/fakeagent/health", { headers: admin.headers })
      const goal = await api.call("/fakeagent/goals", {
        method: "POST",
        headers: admin.headers,
        body: JSON.stringify({ goal: "ping" }),
      })
      score.check(
        "the generic surface answers through the shared contract",
        health.status === 200 &&
          health.body?.state === "ready" &&
          goal.status === 200 &&
          goal.body?.answer === "no runtime here",
        `health=${health.status} goal=${goal.status}`,
      )

      const spec = await api.call("/openapi.json", { headers: admin.headers })
      const paths = Object.keys(spec.body?.paths ?? {})
      const WANTED = ["/fakeagent/health", "/fakeagent/context", "/fakeagent/goals", "/fakeagent/trace"]
      score.check(
        "the catalogue is the only client contract",
        WANTED.every((p) => paths.includes(p)),
      )
    }
    await stopServer(server)
    dropFixture()
    dropScratch(data)
  }

  // --- 3. no agent plugin at all: the system does not miss it ---------------------------------
  {
    const port = await freePort()
    const data = scratchDataDir("agent-absent")
    const api = client(port)
    const server = await startServer(port, { QWBE_DATA_DIR: data })
    if (!server.alive) {
      score.check("Qwbe boots with no plugin on disk", false, server.output)
    } else {
      const admin = await api.login()
      const cubes = await api.call("/settings/cubes", { headers: admin.headers })
      const names = (cubes.body ?? []).map((cube) => cube.name)
      const anyAgent = (cubes.body ?? []).some((cube) => cube.agent === true)
      const notes = await api.call("/notes", { headers: admin.headers })
      score.check(
        "Qwbe boots with no plugin on disk and core cubes work",
        cubes.status === 200 && !anyAgent && notes.status === 200,
        `cubes=${names.join(",")}`,
      )
    }
    await stopServer(server)
    dropScratch(data)
  }
} finally {
  dropFixture()
  restore()
}

process.exit(score.report("Generic agent surface probe"))
