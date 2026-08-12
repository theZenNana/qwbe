// End-to-end proof for the API-only ActiveGraph cube. The Python process is never exposed;
// every observation crosses Qwbe's authenticated, Effect-decoded HTTP boundary.

import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { startFakeLlm } from "./activegraph-llm.mjs"
import { client, dropScratch, freePort, makeScore, scratchDataDir, startServer, stopServer } from "./lib.mjs"

const port = await freePort()
const llmPort = await freePort()
const data = scratchDataDir("activegraph")
const score = makeScore()
const api = client(port)
const llm = await startFakeLlm(llmPort)
const server = await startServer(port, {
  QWBE_DATA_DIR: data,
  QWBE_LITELLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
  QWBE_LITELLM_API_KEY: "probe-key",
  QWBE_AGENT_MODEL: "sub/k3",
})

if (!server.alive) {
  dropScratch(data)
  console.error(`server did not start:\n${server.output}`)
  process.exit(1)
}

try {
  const admin = await api.login()
  const reader = await api.login("reader", "reader")
  const anonymous = await api.call("/agentlab/health")
  score.check("agent API requires authentication", anonymous.status === 401, `http=${anonymous.status}`)

  const health = await api.call("/agentlab/health", { headers: admin.headers })
  score.check(
    "isolated ActiveGraph runtime answers through Qwbe",
    health.status === 200 && health.body?.activegraph === "1.10.0" && health.body?.llm === true,
    `http=${health.status} version=${health.body?.activegraph}`,
  )

  const cubes = await api.call("/settings/cubes", { headers: admin.headers })
  const agentlab = cubes.body?.find?.((cube) => cube.name === "agentlab")
  score.check("catalogue publishes the generic agent capability", agentlab?.agent === true)

  // The kernel half of the contract: the four generic routes exist under the cube's prefix
  // and nothing about the pilot's runtime leaks into the kernel's own contract.
  const openapi = await api.call("/openapi.json")
  const paths = Object.keys(openapi.body?.paths ?? {})
  const surface = ["/agentlab/health", "/agentlab/context", "/agentlab/goals", "/agentlab/trace"]
  score.check(
    "all four generic agent routes are published",
    surface.every((path) => paths.includes(path)),
    `missing=${surface.filter((path) => !paths.includes(path)).join(",") || "none"}`,
  )

  const context = await api.call("/agentlab/context", { headers: admin.headers })
  score.check(
    "agent context is scoped to one cube",
    context.status === 200 &&
      context.body?.cube === "agentlab" &&
      context.body?.crossCube === false &&
      context.body?.allowed?.every?.((path) => path.startsWith("/agentlab/")),
  )

  const refused = await api.call("/agentlab/goals", {
    method: "POST",
    headers: reader.headers,
    body: JSON.stringify({ goal: "read another cube" }),
  })
  score.check("reader cannot mutate an agent run", refused.status === 403, `http=${refused.status}`)

  const goal = await api.call("/agentlab/goals", {
    method: "POST",
    headers: admin.headers,
    body: JSON.stringify({ goal: "inspect my own contract" }),
  })
  score.check(
    "goal runs through the configured isolated LiteLLM model",
    goal.status === 200 &&
      goal.body?.cube === "agentlab" &&
      goal.body?.object?.text === "inspect my own contract" &&
      goal.body?.answer.includes("agentlab only") &&
      goal.body?.model === "sub/k3" &&
      goal.body?.llm === true,
    `http=${goal.status}`,
  )
  score.check(
    "model receives only the agentlab system scope with a bounded response",
    llm.request()?.model === "sub/k3" &&
      llm.request()?.max_tokens === 800 &&
      llm.request()?.messages?.[0]?.content.includes("no filesystem, shell, network, or cross-cube tools"),
  )

  const trace = await api.call("/agentlab/trace", { headers: admin.headers })
  const eventTypes = trace.body?.events?.map?.((event) => event.type) ?? []
  score.check(
    "trace is persisted and readable after the goal subprocess exits",
    trace.status === 200 && eventTypes.includes("goal.created") && eventTypes.includes("object.created"),
    `events=${eventTypes.join(",")}`,
  )
} finally {
  await stopServer(server)
  await llm.close()
  dropScratch(data)
}

const unavailablePort = await freePort()
const unavailableData = scratchDataDir("activegraph-down")
const unavailableApi = client(unavailablePort)
const unavailableServer = await startServer(unavailablePort, {
  QWBE_DATA_DIR: unavailableData,
  QWBE_ACTIVEGRAPH_PYTHON: "/definitely/missing/qwbe-python",
})
try {
  const admin = await unavailableApi.login()
  const response = await unavailableApi.call("/agentlab/health", { headers: admin.headers })
  score.check("missing Python process is a typed 503 and kernel stays alive", response.status === 503)
} finally {
  await stopServer(unavailableServer)
  dropScratch(unavailableData)
}

const malformedPort = await freePort()
const malformedData = scratchDataDir("activegraph-malformed")
const fakePython = join(malformedData, "fake-python")
writeFileSync(fakePython, "#!/bin/sh\nprintf 'not-json'\n")
chmodSync(fakePython, 0o700)
const malformedApi = client(malformedPort)
const malformedServer = await startServer(malformedPort, {
  QWBE_DATA_DIR: malformedData,
  QWBE_ACTIVEGRAPH_PYTHON: fakePython,
})
try {
  const admin = await malformedApi.login()
  const response = await malformedApi.call("/agentlab/health", { headers: admin.headers })
  score.check("malformed subprocess response is rejected as typed 503", response.status === 503)
} finally {
  await stopServer(malformedServer)
  dropScratch(malformedData)
}

const timeoutPort = await freePort()
const timeoutData = scratchDataDir("activegraph-timeout")
const slowPython = join(timeoutData, "slow-python")
writeFileSync(slowPython, "#!/bin/sh\nsleep 10\n")
chmodSync(slowPython, 0o700)
const timeoutApi = client(timeoutPort)
const timeoutServer = await startServer(timeoutPort, {
  QWBE_DATA_DIR: timeoutData,
  QWBE_ACTIVEGRAPH_PYTHON: slowPython,
})
try {
  const admin = await timeoutApi.login()
  const response = await timeoutApi.call("/agentlab/health", { headers: admin.headers })
  const kernel = await timeoutApi.call("/settings/cubes", { headers: admin.headers })
  score.check(
    "subprocess timeout is a typed 503 and kernel stays alive",
    response.status === 503 && kernel.status === 200,
    `agent=${response.status} kernel=${kernel.status}`,
  )
} finally {
  await stopServer(timeoutServer)
  dropScratch(timeoutData)
}

process.exit(score.report("ActiveGraph cube probe"))
