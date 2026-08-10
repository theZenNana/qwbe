// Disk/process drift, observed through the settings HTTP API.
//
// A clean checkout has crm-pack mounted from the same directory the process discovered at boot.
// Package-name overlap must not turn erp-pack's uninstalled `contacts` into fake drift.

import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { diskDrift } from "../web/lib/drift.ts"
import { client, coreDir, dropScratch, freePort, makeScore, scratchDataDir, startServer, stopServer } from "./lib.mjs"
import { fingerprint } from "./lifecycle-bench.mjs"

const port = await freePort()
const dataDir = scratchDataDir("drift")
const api = client(port)
const score = makeScore()
const backup = mkdtempSync(join(tmpdir(), "qwbe-drift-plugins-"))
const crmAt = join(coreDir, "plugins", "crm-pack")
const erpAt = join(coreDir, "plugins", "erp-pack")
const crmBackup = join(backup, "crm-pack")
const before = fingerprint()
cpSync(crmAt, crmBackup, { recursive: true })

let server = await startServer(port, { QWBE_DATA_DIR: dataDir })

const banner = async () => {
  const session = await api.login()
  const cubes = (await api.call("/settings/cubes", { headers: session.headers })).body
  const store = (await api.call("/settings/packages", { headers: session.headers })).body
  score.check(
    "catalogue exposes boolean disk presence for every mounted cube",
    cubes.every((cube) => typeof cube.onDisk === "boolean"),
  )
  return diskDrift(cubes, store)
}

const expectBanner = async (state, expected) => {
  const actual = await banner()
  const missing = [...actual.mountedNotOnDisk].sort()
  score.check(
    state,
    actual.pendingRestart === expected.length > 0 && JSON.stringify(missing) === JSON.stringify(expected),
    `pending=${actual.pendingRestart} missing=${JSON.stringify(missing)}`,
  )
}

const restart = async () => {
  await stopServer(server)
  server = await startServer(port, { QWBE_DATA_DIR: dataDir })
  if (!server.alive) throw new Error(`server did not restart:\n${server.output}`)
}

try {
  if (!server.alive) throw new Error(`server did not start:\n${server.output}`)
  await expectBanner("1. clean checkout has no drift", [])
  await restart()
  await expectBanner("2. clean checkout remains consistent after restart", [])

  let session = await api.login()
  let response = await api.call("/settings/packages/crm-pack", { method: "DELETE", headers: session.headers })
  if (response.status !== 200) throw new Error(`could not remove crm-pack: http=${response.status}`)
  await restart()
  session = await api.login()
  response = await api.call("/settings/packages/erp-pack/install", { method: "POST", headers: session.headers })
  if (response.status !== 200) throw new Error(`could not install erp-pack: http=${response.status}`)
  await restart()
  await expectBanner("3. erp-pack mounted from its own directory has no drift", [])

  rmSync(erpAt, { recursive: true, force: true })
  cpSync(crmBackup, crmAt, { recursive: true })
  await expectBanner("4. real drift names exactly erp-pack's three missing cubes", [
    "accounts",
    "contacts",
    "erp-settings",
  ])

  await restart()
  await expectBanner("5. restart mounts crm-pack and clears the real drift", [])
} finally {
  await stopServer(server)
  rmSync(erpAt, { recursive: true, force: true })
  rmSync(crmAt, { recursive: true, force: true })
  if (existsSync(crmBackup)) cpSync(crmBackup, crmAt, { recursive: true })
  dropScratch(dataDir)
  rmSync(backup, { recursive: true, force: true })
}

const after = fingerprint()
const changed = [...after].filter(([path, hash]) => before.get(path) !== hash).map(([path]) => path)
const vanished = [...before.keys()].filter((path) => !after.has(path))
score.check("probe restores the source tree byte-for-byte", changed.length === 0 && vanished.length === 0)

process.exit(score.report("Disk/process drift probe"))
