// The admin restart button, through the documented `npm start` supervisor.

import { spawn } from "node:child_process"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  client,
  dropDatabase,
  dropScratch,
  freePort,
  makeScore,
  root,
  scratchDatabase,
  scratchDataDir,
  wait,
} from "./lib.mjs"

const apiPort = await freePort()
const webPort = await freePort()
const dataDir = scratchDataDir("admin-restart")
const dbUrl = await scratchDatabase("admin-restart")
const webDistName = `.next-admin-restart-${webPort}`
const webDistDir = join(root, "web", webDistName)
const generatedFiles = ["next-env.d.ts", "tsconfig.json", "AGENTS.md", "CLAUDE.md"].map((name) =>
  join(root, "web", name),
)
const generatedBefore = new Map(generatedFiles.map((path) => [path, existsSync(path) ? readFileSync(path) : null]))
const score = makeScore()
const child = spawn(process.execPath, ["scripts/start.mjs"], {
  cwd: root,
  env: {
    ...process.env,
    QWBE_PORT: String(apiPort),
    QWBE_WEB_PORT: String(webPort),
    QWBE_WEB_DIST_DIR: webDistName,
    QWBE_DATA_DIR: dataDir,
    QWBE_DATABASE_URL: dbUrl,
    QWBE_ADMIN_PASSWORD: "admin",
  },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
})

let output = ""
let exited = null
child.stdout.on("data", (chunk) => (output += chunk))
child.stderr.on("data", (chunk) => (output += chunk))
child.on("exit", (code, signal) => (exited = { code, signal }))

const answers = async (url) => {
  try {
    // The API spec is behind authentication (QWB-41); 401 still means "listening".
    const r = await fetch(url)
    return r.ok || r.status === 401
  } catch {
    return false
  }
}

const waitFor = async (condition, attempts = 120) => {
  for (let i = 0; i < attempts; i++) {
    if (await condition()) return true
    await wait(250)
  }
  return false
}

try {
  const apiUrl = `http://127.0.0.1:${apiPort}/openapi.json`
  const webUrl = `http://127.0.0.1:${webPort}`
  if (!(await waitFor(() => answers(apiUrl)))) throw new Error(`API did not start:\n${output.slice(-1200)}`)
  if (!(await waitFor(() => answers(webUrl)))) throw new Error(`web did not start:\n${output.slice(-1200)}`)

  const api = client(apiPort)
  const session = await api.login()
  const response = await api.call("/settings/restart", { method: "POST", headers: session.headers })
  score.check("admin restart request is accepted", response.status === 200, `http=${response.status}`)

  const apiStopped = await waitFor(async () => !(await answers(apiUrl)), 20)
  score.check("API process actually exits", apiStopped)
  const apiReturned = await waitFor(() => answers(apiUrl), 80)
  score.check("API returns under the documented start runner", apiReturned)
  score.check("start runner remains alive", exited === null, exited ? JSON.stringify(exited) : "alive")
  score.check("frontend remains alive during API restart", await answers(webUrl))
} finally {
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {
    /* already stopped */
  }
  await wait(800)
  try {
    process.kill(-child.pid, "SIGKILL")
  } catch {
    /* already stopped */
  }
  dropScratch(dataDir)
  await dropDatabase(dbUrl)
  rmSync(webDistDir, { recursive: true, force: true })
  for (const [path, content] of generatedBefore) {
    if (content === null) rmSync(path, { force: true })
    else writeFileSync(path, content)
  }
}

process.exit(score.report("Admin restart probe"))
