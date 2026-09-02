// The CUSTOMFIELDS probe -- the SYSTEM cube in core/src/cubes/customfields, over HTTP (QWB-54
// ticket 04: the former customfields-pack moved into the kernel, next to auth and account).
//
//   node probes/customfields.mjs        (with `npm run db:up` first: Postgres on :5433)
//
// QWB-46 acceptance, end to end: values live in the TARGET row's own body under the reserved
// `custom` sub-object, not in a sidecar table. The walk itself lives in customfields-walk.mjs
// (phase 1) and customfields-orphan.mjs (phase 2) -- split out because the file passed the size
// cap. This driver owns the environment: it installs the fixture cube the fields are defined
// on, restarts so it mounts, and leaves the tree exactly as it was found. The database is
// created and dropped by this probe, so the restart proves persistence.
//
// The TARGET is a fixture cube shipped under probes/fixtures/ (review fix 20): the walk used to
// refuse unless an untracked crm-pack install existed, so the acceptance criterion could not
// run on CI or a fresh checkout. Nothing about the fold is crm-specific.

import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { walkPhase2 } from "./customfields-orphan.mjs"
import { walkPhase1 } from "./customfields-walk.mjs"
import {
  client,
  dropDatabase,
  dropScratch,
  freePort,
  makeScore,
  root,
  scratchDatabase,
  scratchDataDir,
  startServer,
  stopServer,
} from "./lib.mjs"

const FIXTURE = join(root, "probes", "fixtures", "guestbook-pack")
const FIXTURE_PACK = "guestbook-pack"
const score = makeScore()

if (!existsSync(FIXTURE)) {
  console.error(`refused: the fixture pack does not exist: ${FIXTURE}`)
  process.exit(1)
}

// A leftover copy from an earlier run would make the install below a silent no-op (or a
// refusal), so the probe refuses to guess whose it is - the same rule install-from uses.
// customfields itself is NOT installed here: as a system cube it ships with the kernel.
{
  const liveAt = join(root, "core", "plugins", FIXTURE_PACK)
  if (existsSync(liveAt)) {
    console.error(`refused: ${liveAt} already exists. Remove it first (it should not be committed).`)
    process.exit(1)
  }
}

const port = await freePort()
const dataDir = scratchDataDir("customfields")
// The probe manages its own database so a restart KEEPS the data -- that is the persistence the
// acceptance criteria ask for. Owned databases are dropped in the finally block.
const dbUrl = await scratchDatabase("customfields")

const boot = () => startServer(port, { QWBE_DATA_DIR: dataDir, QWBE_DATABASE_URL: dbUrl })

let server = await boot()
if (!server.alive) {
  console.error(`server did not start:\n${server.output}`)
  dropScratch(dataDir)
  await dropDatabase(dbUrl)
  process.exit(1)
}

/** Stop, boot again, log in again, and return a FRESH session for the new server.
 *
 *  Sessions live in Postgres and DO survive a restart (measured: a pre-restart caller keeps
 *  working). Each reboot still logs in again on purpose -- a probe must never silently depend
 *  on session persistence -- and every caller below is the one created AFTER the restart it
 *  addresses (review fix 18: the walk used to pass a caller from before the restart, which
 *  only worked by the accident above). */
const reboot = async () => {
  await stopServer(server)
  server = await boot()
  if (!server.alive) {
    console.error(`server did not restart:\n${server.output}`)
    process.exit(1)
  }
  const fresh = await client(port).login()
  return (path, options = {}) => client(port).call(path, { ...options, headers: fresh.headers })
}

const install = async (asAdmin, path, name) => {
  const r = await asAdmin("/settings/packages/install-from", {
    method: "POST",
    body: JSON.stringify({ path }),
  })
  score.check(
    `${name} installs from its source directory`,
    r.status === 200,
    `http=${r.status} ${JSON.stringify(r.body).slice(0, 200)}`,
  )
}

try {
  const first = await client(port).login()
  const asAdmin = (path, options = {}) => client(port).call(path, { ...options, headers: first.headers })

  // ---- install the fixture cube, restart, confirm it mounts ---------------------------------
  await install(asAdmin, FIXTURE, "the fixture cube")

  await asAdmin("/settings/restart", { method: "POST", body: "{}" })
  await reboot()

  const phase1 = await walkPhase1({ score, asAdmin, reboot })
  // The fresh caller walkPhase1 created AFTER its reboot is the live one (review fix 18): the
  // outer caller from before that restart only worked by the accident that sessions live in
  // Postgres and survive. Use what the phase that did the restart returned.
  await walkPhase2({ score, asAdmin2: phase1.asAdmin2, entryId: phase1.entryId, cube: "guestbook" })

  // ---- leave as found: the install goes, so the next run installs from scratch --------------
  const undo = await phase1.asAdmin2(`/settings/packages/${FIXTURE_PACK}`, { method: "DELETE" })
  score.check(`${FIXTURE_PACK} uninstalls cleanly at the end`, undo.status === 200, `http=${undo.status}`)
} catch (e) {
  console.error(e.message)
  score.check("probe ran to completion", false, e.message)
} finally {
  await stopServer(server).catch(() => {})
  rmSync(join(root, "core", "plugins", FIXTURE_PACK), { recursive: true, force: true })
  dropScratch(dataDir)
  await dropDatabase(dbUrl)
}

process.exit(score.report("customfields"))
