// Disk/process drift, observed through the settings HTTP API.
//
//   node probes/drift.mjs
//
// The fixture is a cube PLANTED as a real directory in `core/src/cubes/` for the duration of
// the run and deleted in `finally`. Nothing committed is ever touched - the pre-QWB-13 version
// deleted crm-pack from the tree and restored it from a copy, and an interrupted run left the
// repo broken (raised in the QWB-12 review). A planted directory is the honest middle ground:
// drift means "mounted but gone from disk", and the only way to be gone from disk is to be a
// real directory that really gets removed. A symlink was tried and rejected: `existsSync`
// follows it, so a dangling link reads as absent even before anything is deleted - no drift.
//
// The shelf beside it (temporary, planted by drift-store.mjs) carries the overlap case: a
// rival package claiming `bookmarks`, which example-plugin already owns, must not be misread
// as drift.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { diskDrift } from "../web/lib/drift.ts"
import { plantRivalStore } from "./drift-store.mjs"
import { client, dropScratch, freePort, makeScore, root, scratchDataDir, startServer, stopServer } from "./lib.mjs"

const port = await freePort()
const dataDir = scratchDataDir("drift")
const api = client(port)
const score = makeScore()

const store = plantRivalStore(join(root, "core", "plugins", "example-plugin"))

const CUBE = "driftcube"
const cubeAt = join(root, "core", "src", "cubes", CUBE)
const CUBE_SOURCE = `// planted by probes/drift.mjs - exists so drift has something real to measure
import { HttpApiGroup } from "@effect/platform"
import type { CubeDefinition } from "../../kernel/manifest.ts"

export const cube: CubeDefinition = {
  manifest: { name: "${CUBE}", tables: [], requiresAuth: true },
  create: () => ({ group: HttpApiGroup.make("${CUBE}"), handlers: {} }),
}
`

// Guard, not politeness: a real driftcube directory would mean the last run died mid-probe, and
// overwriting it would make two wrongs.
if (existsSync(cubeAt)) throw new Error(`${cubeAt} already exists - a previous run did not clean up`)
mkdirSync(cubeAt)
writeFileSync(join(cubeAt, "index.ts"), CUBE_SOURCE)

let server = await startServer(port, { QWBE_DATA_DIR: dataDir, QWBE_STORE_DIR: store })

const banner = async () => {
  const session = await api.login()
  const cubes = (await api.call("/settings/cubes", { headers: session.headers })).body
  const storeBody = (await api.call("/settings/packages", { headers: session.headers })).body
  score.check(
    "catalogue exposes boolean disk presence for every mounted cube",
    cubes.every((cube) => typeof cube.onDisk === "boolean"),
  )
  return diskDrift(cubes, storeBody)
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
  server = await startServer(port, { QWBE_DATA_DIR: dataDir, QWBE_STORE_DIR: store })
  if (!server.alive) throw new Error(`server did not restart:\n${server.output}`)
}

try {
  if (!server.alive) throw new Error(`server did not start:\n${server.output}`)

  await expectBanner("1. clean start has no drift - the rival's uninstalled overlap is not fake drift", [])
  await restart()
  await expectBanner("2. restart keeps the clean state clean", [])

  // Installing the shelf copy of example-plugin: the destination directory already exists (the
  // plugin ships with the repo), so the install is refused - and the refusal leaves no drift.
  const session = await api.login()
  const clash = await api.call("/settings/packages/example-plugin/install", {
    method: "POST",
    headers: session.headers,
  })
  score.check(
    "3. installing a second copy of a mounted plugin is refused",
    clash.status === 400 && String(clash.body?.message ?? clash.body ?? "").includes("already exists"),
    `http=${clash.status} - ${String(clash.body?.message ?? "").slice(0, 90)}`,
  )
  await expectBanner("4. the refused install left no drift behind", [])

  // Real drift: delete the planted cube. The running server still has driftcube mounted.
  rmSync(cubeAt, { recursive: true, force: true })
  await expectBanner("5. real drift names exactly the vanished cube", [CUBE])

  // Healing without a route: put the files back and the banner clears on the same process.
  mkdirSync(cubeAt)
  writeFileSync(join(cubeAt, "index.ts"), CUBE_SOURCE)
  await expectBanner("6. restoring the directory clears the drift without a restart", [])
} finally {
  await stopServer(server)
  rmSync(cubeAt, { recursive: true, force: true })
  dropScratch(dataDir)
  rmSync(store, { recursive: true, force: true })
}

// The probe's own side effect is measured, not asserted: the cubes directory must hold exactly
// the names it held when the run started. `driftcube` absent is the proof the cleanup ran.
score.check(
  "the checkout is clean - no planted cube left behind",
  !existsSync(cubeAt) && !readdirSync(join(root, "core", "src", "cubes")).includes(CUBE),
  `${CUBE} absent`,
)

process.exit(score.report("Disk/process drift probe"))
