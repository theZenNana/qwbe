// Attacks on the install routes.
//
// Installing means the API writes directories onto disk. That is the widest thing this system
// does, so it gets the harshest probe: every check here is an attack, and the ones that pass
// are the ones that were REFUSED.
//
// The probe builds its own store in a temp directory (`QWBE_STORE_DIR`) rather than using the
// real one, so it proves the mechanism instead of whatever happens to be shipped today. Two of
// the packages it plants are deliberately malformed — a store is exactly where a bad package
// arrives from.
//
//   node probes/install.mjs

import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { permissionsHold, traversalIsRefused } from "./install-refusals.mjs"
import { fingerprint, plantStore } from "./install-store.mjs"
import { installWorks, nameCollisionIsRefused, undoBeforeRestart } from "./install-writes.mjs"
import {
  client,
  coreDir,
  dropScratch,
  freePort,
  makeScore,
  scratchDataDir,
  startServer,
  stopServer,
  wait,
} from "./lib.mjs"

// Own port, own databases. 4507 was shared with `security` and `customfields`, and `<root>/data`
// with whatever server the owner happens to have open — see `lib.mjs`.
const PORT = await freePort()
const dataDir = scratchDataDir("install")
const cubesDir = join(coreDir, "src", "cubes")
const pluginsDir = join(coreDir, "plugins")
const score = makeScore()

// The store it attacks, and the fingerprint it measures with, are in `install-store.mjs`.
const store = plantStore()

const before = fingerprint(join(coreDir, "src"))

// The removal check below deletes a real cube, so a copy is taken FIRST and restored from that
// copy at the end.
//
// The first version restored it with `git checkout -- core/src/cubes/notes`. That silently threw
// away an uncommitted edit to that file — mine, made minutes earlier, and the probe suite went
// green because the check that would have caught it runs before this one. A probe that deletes
// working-tree changes is a trap, not a safeguard: it is quietest exactly when it costs most.
const notesDir = join(cubesDir, "notes")
const notesBackup = mkdtempSync(join(tmpdir(), "qwbe-notes-"))
cpSync(notesDir, notesBackup, { recursive: true })

// ---------------------------------------------------------------- run

const server = await startServer(PORT, { QWBE_STORE_DIR: store, QWBE_DATA_DIR: dataDir })
if (!server.alive) {
  console.error(`server did not start:\n${server.output}`)
  process.exit(1)
}

const api = client(PORT)
const admin = await api.login()
const reader = await api.login("reader", "reader")

const planted = join(cubesDir, "probecube")
const plantedPlugin = join(pluginsDir, "probeplugin")

try {
  // ============ 1. the store lists what it should, and hides what it should ============

  const list = await api.call("/settings/packages", { headers: admin.headers })
  const names = (list.body ?? []).map((p) => p.name)
  score.check("store: a well-formed package is offered", names.includes("probecube"), names.join(", "))
  score.check("store: a plugin package is offered", names.includes("probeplugin"))
  score.check(
    "store: a directory with no manifest is not a package — it is not offered",
    !names.includes("notapackage"),
    "a store is where a bad package arrives from; scratch must not become installable",
  )
  score.check(
    "store: a package whose manifest names another cube is dropped from the list",
    !names.includes("liarcube") && !names.includes("somethingelse"),
    "installing under one name while appearing under another is how you shadow an existing cube",
  )
  score.check(
    "store: one malformed package does not take the whole list down",
    names.length >= 2,
    `${names.length} listed despite two bad directories present`,
  )

  // ============ 2 and 3. what must be refused ============
  //
  // Path traversal and the permission wall, in `install-refusals.mjs`. Order matters: the
  // permission checks assert that nothing landed on disk, which is only true before section 4
  // installs anything.
  await traversalIsRefused({ api, score, admin })
  await permissionsHold({ api, score, reader, planted })

  // ============ 4 and 4b. a real install, and undoing it before the restart ============
  await installWorks({ api, score, admin, planted, plantedPlugin })
  await undoBeforeRestart({ api, score, admin, reader, plantedPlugin })

  // ============ 4c. two packages bringing the same cube name ============
  await nameCollisionIsRefused({ api, score, admin, pluginsDir })

  // ============ 5. the invariant, measured ============

  const after = fingerprint(join(coreDir, "src"))
  const changed = [...before].filter(([p, h]) => after.has(p) && after.get(p) !== h).map(([p]) => p)
  const removed = [...before].filter(([p]) => !after.has(p)).map(([p]) => p)
  const added = [...after].filter(([p]) => !before.has(p)).map(([p]) => p)

  score.check(
    "invariant: installing changed NO existing file",
    changed.length === 0,
    `${before.size} files fingerprinted before, ${changed.length} altered`,
  )
  score.check("invariant: installing deleted no existing file", removed.length === 0, removed.join(", "))
  score.check(
    "invariant: it only ADDED files, all inside the new cube's own directory",
    added.length > 0 && added.every((p) => p.includes("cubes/probecube")),
    added.join(", "),
  )

  // ============ 6. removal ============

  for (const required of ["auth", "account", "settings"]) {
    const r = await api.call(`/settings/cubes/${required}`, { method: "DELETE", headers: admin.headers })
    score.check(
      `removal: the required cube "${required}" cannot be deleted`,
      r.status === 400,
      `http=${r.status} — deleting auth from a web page removes the way back in`,
    )
  }

  const ghost = await api.call("/settings/cubes/nosuchcube", { method: "DELETE", headers: admin.headers })
  score.check(
    "removal: an unmounted cube gives 404, not a filesystem error",
    ghost.status === 404,
    `http=${ghost.status}`,
  )

  const removeNotes = await api.call("/settings/cubes/notes", { method: "DELETE", headers: admin.headers })
  score.check(
    "removal: a non-required cube can be removed — 200",
    removeNotes.status === 200,
    `http=${removeNotes.status}`,
  )
  score.check("removal: its directory is gone from disk", !existsSync(join(cubesDir, "notes")))
  score.check("removal: the response also says a restart is needed", removeNotes.body?.requiresRestart === true)
} finally {
  await stopServer(server)
  await wait(200)

  // Put the tree back exactly as it was. A probe that leaves the repository different from how
  // it found it makes every later run mean something else.
  rmSync(planted, { recursive: true, force: true })
  rmSync(plantedPlugin, { recursive: true, force: true })
  rmSync(store, { recursive: true, force: true })

  // Restored from the copy taken before anything ran — byte for byte what was there, including
  // edits that were never committed.
  if (!existsSync(notesDir)) cpSync(notesBackup, notesDir, { recursive: true })
  rmSync(notesBackup, { recursive: true, force: true })
  dropScratch(dataDir)
}

const restored = existsSync(join(cubesDir, "notes"))
score.check("cleanup: the tree is back as it was — notes restored, probe leftovers gone", restored)

process.exit(score.report("Install probe"))
