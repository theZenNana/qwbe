// The CUSTOMFIELDS probe -- the plugin at plugins/customfields-pack, exercised over HTTP.
//
//   node probes/customfields.mjs
//
// The pack lives in its own repository, a sibling of this one under the owner's Projects
// directory, and reaches this machine through the same door an administrator uses: install-from.
// The probe installs it from that directory, restarts so the cube mounts, and then walks the
// surface the web UI sits on: define a field, list the definitions, write a value, read it
// back, and refuse a value the definition says cannot exist. Every response body is checked
// against the same fields the web schemas require, so a missing or retyped field turns the
// probe red instead of silently rendering an empty panel in the UI.
//
// Scratch directories, a free port, and the plugin copy uninstalled at the end -- the repo is
// left exactly as it was found.

import { existsSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { client, dropScratch, freePort, makeScore, root, scratchDataDir, startServer, stopServer } from "./lib.mjs"

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

// The install copies the pack into core/plugins and the kernel reads that directory once, at
// startup. A leftover copy from an earlier run would make the install below a silent no-op
// (or a refusal), so the probe refuses to guess whose it is - the same rule install-from uses.
const liveAt = join(root, "core", "plugins", PACK)
if (existsSync(liveAt)) {
  console.error(`refused: ${liveAt} already exists. Remove it first (it should not be committed).`)
  process.exit(1)
}

const port = await freePort()
const dataDir = scratchDataDir("customfields")
const storeDir = scratchDataDir("customfields-store")

const boot = () => startServer(port, { QWBE_DATA_DIR: dataDir, QWBE_STORE_DIR: storeDir })

let server = await boot()
if (!server.alive) {
  console.error(`server did not start:\n${server.output}`)
  // The scratch directories exist by now -- clean them up on this path too, not only in the
  // finally below, so a failed boot does not leave them behind.
  dropScratch(dataDir)
  dropScratch(storeDir)
  process.exit(1)
}

try {
  const admin = await client(port).login()
  const call = (path, options = {}) => client(port).call(path, { ...options, headers: admin.headers })

  // ---- install from the pack's own repository, restart, and confirm the routes exist ----------
  const install = await call("/settings/packages/install-from", {
    method: "POST",
    body: JSON.stringify({ path: SOURCE }),
  })
  score.check(
    "the pack installs from its own repository",
    install.status === 200 && install.body?.package?.name === PACK,
    `http=${install.status}`,
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

  const define = await asAdmin("/customfields", {
    method: "POST",
    body: JSON.stringify({ targetCube: "notes", name: "priority", fieldType: "number" }),
  })
  score.check(
    "a number field is defined on notes",
    define.status === 200 && define.body?.name === "priority" && define.body?.fieldType === "number",
    `http=${define.status}`,
  )

  const list = await asAdmin("/customfields?limit=200")
  // The fields the web's CustomFieldDefSchema requires: a missing or retyped one would make
  // the panel render nothing while this check stayed green, so each is asserted explicitly.
  const listed = list.body?.rows?.find((d) => d.name === "priority")
  const defFieldsOk =
    listed &&
    typeof listed.id === "string" &&
    listed.targetCube === "notes" &&
    typeof listed.label === "string" &&
    listed.fieldType === "number" &&
    Array.isArray(listed.options) &&
    typeof listed.required === "boolean" &&
    typeof listed.position === "number"
  score.check(
    "the definition is in the list with every field the web schema requires",
    list.status === 200 && Boolean(defFieldsOk) && typeof list.body?.total === "number",
    `http=${list.status} total=${list.body?.total} fieldsOk=${Boolean(defFieldsOk)}`,
  )

  const write = await asAdmin("/customfields/values", {
    method: "PUT",
    body: JSON.stringify({ cube: "notes", rowId: "cf-probe-1", values: { priority: "7" } }),
  })
  score.check(
    "a value is written and comes back in the same call",
    write.status === 200 && write.body?.fields?.find((f) => f.name === "priority")?.value === "7",
    `http=${write.status}`,
  )

  const read = await asAdmin("/customfields/values?cube=notes&rowId=cf-probe-1")
  // RowFieldsSchema requires cube, rowId and a fields array whose entries carry name, label,
  // fieldType, options, required, position and value -- the shape the panel renders from.
  const rf = read.body
  const field = rf?.fields?.find((f) => f.name === "priority")
  const rowFieldsOk =
    rf?.cube === "notes" &&
    rf?.rowId === "cf-probe-1" &&
    field?.value === "7" &&
    typeof field?.label === "string" &&
    field?.fieldType === "number" &&
    Array.isArray(field?.options) &&
    typeof field?.required === "boolean" &&
    typeof field?.position === "number"
  score.check(
    "the value reads back on a fresh lookup with every field the web schema requires",
    read.status === 200 && Boolean(rowFieldsOk),
    `http=${read.status} rowFieldsOk=${Boolean(rowFieldsOk)}`,
  )

  const bad = await asAdmin("/customfields/values", {
    method: "PUT",
    body: JSON.stringify({ cube: "notes", rowId: "cf-probe-1", values: { priority: "seven" } }),
  })
  score.check(
    "a value that is not a number is refused with 400 and a reason",
    bad.status === 400 && String(bad.body?.message).includes("priority"),
    `http=${bad.status} message=${bad.body?.message}`,
  )

  // Leave as found: the install copy goes, so the next run installs from scratch.
  const undo = await asAdmin(`/settings/packages/${PACK}`, { method: "DELETE" })
  score.check("the pack uninstalls cleanly at the end", undo.status === 200, `http=${undo.status}`)
} finally {
  await stopServer(server)
  rmSync(liveAt, { recursive: true, force: true })
  dropScratch(dataDir)
  dropScratch(storeDir)
}

process.exit(score.report("customfields"))
