// The CUSTOMFIELDS probe -- the plugin at plugins/customfields-pack, exercised over HTTP.
//
//   node probes/customfields.mjs        (with `npm run db:up` first: Postgres on :5433)
//
// QWB-46 acceptance, end to end: values live in the TARGET row's own body under the reserved
// `custom` sub-object, not in a sidecar table. The walk itself lives in customfields-walk.mjs
// (phase 1) and customfields-orphan.mjs (phase 2) -- split out because the file passed the size
// cap. This driver owns the environment: it installs the pack, restarts so the cube mounts, and
// leaves the tree exactly as it was found. The database is created and dropped by this probe,
// so the restart proves persistence.

import { existsSync, rmSync } from "node:fs"
import { homedir } from "node:os"
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

// Overridable with CUSTOMFIELDS_PACK; the default is the sibling checkout, never a literal
// home path (the secretlint rule in .secretlintrc.json exists to keep those out).
const SOURCE = process.env.CUSTOMFIELDS_PACK ?? join(homedir(), "Projects", "Qwbe", "plugins", "customfields-pack")
const PACK = "customfields-pack"
const score = makeScore()

if (!existsSync(SOURCE)) {
  console.error(`refused: the pack source directory does not exist: ${SOURCE}`)
  console.error("set CUSTOMFIELDS_PACK to the customfields-pack checkout and retry.")
  process.exit(1)
}
// crm/contacts must be mounted for the acceptance walk: the probe uses the per-machine
// crm-pack install when this checkout has one (core/plugins, gitignored, never committed).
if (!existsSync(join(root, "core", "plugins", "crm-pack", "cubes", "crm", "contacts"))) {
  console.error("refused: crm-pack is not installed in core/plugins, so crm/contacts cannot mount.")
  console.error("Copy a crm-pack install into core/plugins (per machine, untracked) and retry.")
  process.exit(1)
}

// A leftover copy from an earlier run would make the install below a silent no-op (or a
// refusal), so the probe refuses to guess whose it is - the same rule install-from uses.
const liveAt = join(root, "core", "plugins", PACK)
if (existsSync(liveAt)) {
  console.error(`refused: ${liveAt} already exists. Remove it first (it should not be committed).`)
  process.exit(1)
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

/** Stop, boot again, log in again: sessions do not survive a restart. */
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

try {
  const first = await client(port).login()
  const asAdmin = (path, options = {}) => client(port).call(path, { ...options, headers: first.headers })

  // ---- install from the pack's own repository, restart, confirm the mount --------------------
  const install = await asAdmin("/settings/packages/install-from", {
    method: "POST",
    body: JSON.stringify({ path: SOURCE }),
  })
  score.check(
    "the pack installs from its own repository",
    install.status === 200 && install.body?.package?.name === PACK,
    `http=${install.status}`,
  )

  await asAdmin("/settings/restart", { method: "POST", body: "{}" })
  const asAdmin2 = await reboot()

  const phase1 = await walkPhase1({ score, asAdmin, reboot })
  await walkPhase2({ score, asAdmin2, contactId: phase1.contactId })

  // ---- leave as found: the install goes, so the next run installs from scratch ---------------
  const undo = await asAdmin2(`/settings/packages/${PACK}`, { method: "DELETE" })
  score.check("the pack uninstalls cleanly at the end", undo.status === 200, `http=${undo.status}`)
} catch (e) {
  console.error(e.message)
  score.check("probe ran to completion", false, e.message)
} finally {
  await stopServer(server).catch(() => {})
  rmSync(liveAt, { recursive: true, force: true })
  dropScratch(dataDir)
  await dropDatabase(dbUrl)
}

process.exit(score.report("customfields"))
