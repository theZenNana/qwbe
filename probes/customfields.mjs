// The CUSTOMFIELDS probe -- the plugin at plugins/customfields-pack, exercised over HTTP.
//
//   node probes/customfields.mjs        (with `npm run db:up` first: Postgres on :5433)
//
// QWB-46 acceptance, end to end: values live in the TARGET row's own body under the reserved
// `custom` sub-object, not in a sidecar table. The probe installs the pack, defines a field on
// crm/contacts, saves a value THROUGH THE CONTACT'S OWN API, reads it back the same way,
// restarts the server and reads it again, then deletes the definition and sees the value
// reported as an orphan rather than lost. The database is created and dropped by this probe, so
// the restart proves persistence and the run leaves nothing behind.

import { existsSync, rmSync } from "node:fs"
import { homedir } from "node:os"
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
  startServer,
  stopServer,
  wait,
} from "./lib.mjs"

// Overridable with CUSTOMFIELDS_PACK; the default is the sibling checkout, never a literal
// home path (the secretlint rule in .secretlintrc.json exists to keep those out).
const SOURCE = process.env.CUSTOMFIELDS_PACK ?? join(homedir(), "Projects", "Qwbe", "plugins", "customfields-pack")
const CRM_SOURCE = process.env.CRM_PACK ?? join(homedir(), "Projects", "Qwbe", "plugins", "crm-pack")
const PACK = "customfields-pack"
const CRM = "crm-pack"
const score = makeScore()

if (!existsSync(SOURCE)) {
  console.error(`refused: the pack source directory does not exist: ${SOURCE}`)
  console.error("set CUSTOMFIELDS_PACK to the customfields-pack checkout and retry.")
  process.exit(1)
}
if (!existsSync(CRM_SOURCE)) {
  console.error(`refused: the crm-pack source directory does not exist: ${CRM_SOURCE}`)
  console.error("set CRM_PACK to the crm-pack checkout and retry.")
  process.exit(1)
}

// The install copies the pack into core/plugins and the kernel reads that directory once, at
// startup. A leftover copy from an earlier run would make the install below a silent no-op
// (or a refusal), so the probe refuses to guess whose it is - the same rule install-from uses.
const liveAt = (name) => join(root, "core", "plugins", name)
if (existsSync(liveAt(PACK))) {
  console.error(`refused: ${liveAt(PACK)} already exists. Remove it first (it should not be committed).`)
  process.exit(1)
}
// crm/contacts must be mounted for the acceptance walk. If this checkout already has the
// per-machine crm-pack install, use it; otherwise install from the sibling checkout and remove
// it again at the end, so the tree is left exactly as it was found.
const crmPreinstalled = existsSync(liveAt(CRM))

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

try {
  const install = async (path, name) =>
    client(port).call("/settings/packages/install-from", {
      method: "POST",
      body: JSON.stringify({ path }),
      headers: (await client(port).login()).headers,
    })

  // ---- install what is missing, restart, confirm the routes exist ----------------------------
  if (!crmPreinstalled) {
    const r = await install(CRM_SOURCE, CRM)
    score.check("crm-pack installs so crm/contacts is mounted", r.status === 200, `http=${r.status}`)
  }

  const first = await client(port).login()
  const call = (path, options = {}) => client(port).call(path, { ...options, headers: first.headers })
  const cfInstall = await call("/settings/packages/install-from", {
    method: "POST",
    body: JSON.stringify({ path: SOURCE }),
  })
  score.check(
    "the pack installs from its own repository",
    cfInstall.status === 200 && cfInstall.body?.package?.name === PACK,
    `http=${cfInstall.status}`,
  )

  // `requiresRestart: true` is the honest answer -- the kernel reads plugins once, at startup.
  await call("/settings/restart", { method: "POST", body: "{}" })
  await stopServer(server)
  server = await boot()
  if (!server.alive) {
    console.error(`server did not restart:\n${server.output}`)
    process.exit(1)
  }
  // Sessions do not survive a restart (the token store lives in the process), so log in again.
  const api = client(port)
  const fresh = await api.login()
  const asAdmin = (path, options = {}) => api.call(path, { ...options, headers: fresh.headers })

  // ---- define a field on crm/contacts ---------------------------------------------------------
  const define = await asAdmin("/customfields", {
    method: "POST",
    body: JSON.stringify({ targetCube: "crm/contacts", name: "cnp", fieldType: "text", label: "CNP" }),
  })
  score.check(
    "a text field is defined on crm/contacts",
    define.status === 200 && define.body?.name === "cnp" && define.body?.targetCube === "crm/contacts",
    `http=${define.status}`,
  )

  const refused = await asAdmin("/customfields", {
    method: "POST",
    body: JSON.stringify({ targetCube: "nowhere/nothing", name: "ghost", fieldType: "text" }),
  })
  score.check(
    "a definition for a cube that is not mounted is refused with a clear message",
    refused.status === 400 && String(refused.body?.message).includes("nowhere/nothing"),
    `http=${refused.status} message=${refused.body?.message}`,
  )

  // ---- the value is saved through the CONTACT'S OWN API and folded into its row --------------
  const create = await asAdmin("/contacts", {
    method: "POST",
    body: JSON.stringify({ name: "Probe Contact", email: "probe@example.test", cnp: "123456789" }),
  })
  const contactId = create.body?.id
  score.check(
    "a contact is created with an undeclared field in the payload",
    create.status === 200 && Boolean(contactId) && create.body?.name === "Probe Contact",
    `http=${create.status}`,
  )

  const readBack = await asAdmin(`/contacts/${contactId}`)
  score.check(
    "the custom value reads back through the contact's own API, under custom",
    readBack.status === 200 && readBack.body?.custom?.cnp === "123456789",
    `http=${readBack.status} custom=${JSON.stringify(readBack.body?.custom)}`,
  )
  score.check(
    "the declared fields are untouched by the fold",
    readBack.body?.name === "Probe Contact" && readBack.body?.email === "probe@example.test",
    `name=${readBack.body?.name}`,
  )

  // ---- the definition still validates: a bad value is refused with a reason ------------------
  const bad = await asAdmin("/customfields/values", {
    method: "PUT",
    body: JSON.stringify({ cube: "crm/contacts", rowId: contactId, values: { cnp: "x".repeat(1001) } }),
  })
  score.check(
    "a value that breaks the definition is refused with 400 and a reason",
    bad.status === 400 && String(bad.body?.message).includes("cnp"),
    `http=${bad.status} message=${String(bad.body?.message).slice(0, 60)}`,
  )

  // ---- metadata: the custom field is published, marked custom --------------------------------
  let metadataField
  for (let i = 0; i < 10 && !metadataField; i++) {
    const meta = await asAdmin(`/catalog/${encodeURIComponent("crm/contacts")}/metadata`)
    metadataField = (meta.body?.fields ?? []).find((f) => f.name === "cnp")
    if (!metadataField) await wait(300)
  }
  score.check(
    "the cube's metadata publishes the active custom field, marked custom: true",
    metadataField?.custom === true && metadataField?.type === "string",
    `custom=${metadataField?.custom} type=${metadataField?.type}`,
  )

  // ---- restart: the value persists in the row -------------------------------------------------
  await call("/settings/restart", { method: "POST", body: "{}" })
  await stopServer(server)
  server = await boot()
  if (!server.alive) {
    console.error(`server did not restart:\n${server.output}`)
    process.exit(1)
  }
  const after = client(port)
  const relogged = await after.login()
  const asAdmin2 = (path, options = {}) => after.call(path, { ...options, headers: relogged.headers })

  const readAfterRestart = await asAdmin2(`/contacts/${contactId}`)
  score.check(
    "after a restart the value is still in the row, read through the contact's own API",
    readAfterRestart.status === 200 && readAfterRestart.body?.custom?.cnp === "123456789",
    `http=${readAfterRestart.status} custom=${JSON.stringify(readAfterRestart.body?.custom)}`,
  )

  // ---- delete the definition: the value stays and is reported as an orphan -------------------
  const defs = await asAdmin2("/customfields?limit=200")
  const cnpDef = (defs.body?.rows ?? []).find((d) => d.name === "cnp")
  const removed = await asAdmin2(`/customfields/${cnpDef?.id}`, { method: "DELETE" })
  score.check(
    "the definition is deleted",
    removed.status === 200 && removed.body?.removed === "crm/contacts.cnp",
    `http=${removed.status}`,
  )

  const orphans = await asAdmin2(`/customfields/orphans?cube=${encodeURIComponent("crm/contacts")}`)
  const reported = (orphans.body?.orphans ?? []).find((o) => o.name === "cnp")
  score.check(
    "the deleted field's value is reported as an orphan, on the same row",
    orphans.status === 200 && reported?.rowId === contactId && reported?.value === "123456789",
    `http=${orphans.status} orphan=${JSON.stringify(reported)}`,
  )

  const stillThere = await asAdmin2(`/contacts/${contactId}`)
  score.check(
    "the orphaned value is still in the row -- deleting the definition deleted nothing",
    stillThere.status === 200 && stillThere.body?.custom?.cnp === "123456789",
    `http=${stillThere.status}`,
  )

  // ---- leave as found: the installs go, so the next run installs from scratch ----------------
  const undo = await asAdmin2(`/settings/packages/${PACK}`, { method: "DELETE" })
  score.check("the pack uninstalls cleanly at the end", undo.status === 200, `http=${undo.status}`)
  if (!crmPreinstalled) {
    const undoCrm = await asAdmin2(`/settings/packages/${CRM}`, { method: "DELETE" })
    score.check("the crm-pack installed for this run uninstalls too", undoCrm.status === 200, `http=${undoCrm.status}`)
  }
} catch (e) {
  console.error(e.message)
  score.check("probe ran to completion", false, e.message)
} finally {
  await stopServer(server).catch(() => {})
  rmSync(liveAt(PACK), { recursive: true, force: true })
  if (!crmPreinstalled) rmSync(liveAt(CRM), { recursive: true, force: true })
  dropScratch(dataDir)
  await dropDatabase(dbUrl)
}

process.exit(score.report("customfields"))
