// The INSTALL-FROM probe - installing a plugin from a directory the administrator points at.
//
//   node probes/install-from.mjs
//
// The one door through which a caller hands the system a PATH:
// POST /settings/packages/install-from (and the CLI twin `settings:install-from`). The kernel
// validates, stages a copy into the store, and installs from there - nothing executes from the
// source. This probe attacks that door from every side the plan named: relative path, missing
// manifest, lying manifest, bad name, symlink escape, cube collision, same fingerprint (must be
// idempotent), same name with different content (must be refused), rollback after a failure, the
// full install-restart-drift-uninstall life, and remove-add-remove repeated.
//
// The sources are planted in temp directories - never committed files - and a SHA-256
// fingerprint of the source tree before/after proves the probe left the repo exactly as found.
// The plugin under test is a renamed copy of example-plugin's bookmarks cube (only bookmarks -
// the plugin's second cube `tags` would mount a duplicate; see lifecycle-bench.mjs).

import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { reviewAttacks } from "./install-from-attacks.mjs"
import { plantSources } from "./install-from-fixtures.mjs"
import { cliTwinSpeaks, driftSpeaks, mountedLife, shelfAndCycles } from "./install-from-life.mjs"
import { dropScratch, makeScore, scratchDataDir, stopServer } from "./lib.mjs"
import { boot, fingerprint, PKG, pluginsDir } from "./lifecycle-bench.mjs"

const score = makeScore()
// Section 6 returns verdicts instead of checking inline - it boots two more servers and the
// list shape keeps the score-collecting in one place.
const verdicts = []

// The probe installs `lifecycle-plugin` and `dirbookmarks` into core/plugins - directories the
// repo never had. Preexistence means the owner's work sits there and the probe cannot tell it
// apart from its own, so it refuses rather than risk deleting it (the rule from lifecycle.mjs).
for (const target of [join(pluginsDir, PKG), join(pluginsDir, "dirplugin")]) {
  if (existsSync(target)) {
    console.error(`refused: ${target} already exists and was not planted by this probe. Remove or rename it first.`)
    process.exit(1)
  }
}

const before = fingerprint()
const store = mkdtempSync(join(tmpdir(), "qwbe-installfrom-store-"))

// The pointed-at directories, planted in temp space by the fixture module - one valid, each of
// the others built to trip exactly one refusal. Never committed files.
const fixtures = plantSources()
const { sources, goodDir, noManifest, liarDir, escapeDir, clashDir, rivalDir } = fixtures

const dataDir = scratchDataDir("installfrom")

try {
  const { server, api } = await boot(dataDir, store)
  if (!server.alive) {
    console.error(`server did not start:\n${server.output}`)
    process.exit(1)
  }
  const admin = await api.login()
  const reader = await api.login("reader", "reader")
  const adminHeaders = admin.headers
  const post = (body, headers = adminHeaders) =>
    api.call("/settings/packages/install-from", { method: "POST", headers, body: JSON.stringify(body) })

  // ============ 1. the door itself: what must be refused, with nothing left behind ============

  const relative = await post({ path: "relative/path/dirplugin" })
  score.check(
    "a relative path is refused",
    relative.status === 400 && String(relative.body?.message).includes("absolute"),
    `http=${relative.status}`,
  )

  const missing = await post({ path: join(sources, "no-such-dir") })
  score.check("a path that does not exist is refused", missing.status === 400, `http=${missing.status}`)

  const noman = await post({ path: noManifest })
  score.check(
    "a directory with no manifest is refused",
    noman.status === 400 && String(noman.body?.message).includes("qwbe-package.json"),
    `http=${noman.status}`,
  )

  const liar = await post({ path: liarDir })
  score.check(
    "a manifest naming another package is refused",
    liar.status === 400 && String(liar.body?.message).includes("declares name"),
    `http=${liar.status}`,
  )

  const sneaky = await post({ path: escapeDir })
  score.check(
    "a symlink inside the tree is refused - the escape hatch is closed",
    sneaky.status === 400 && String(sneaky.body?.message).includes("symlink"),
    `http=${sneaky.status} - cpSync follows links; the check runs before the copy`,
  )

  const clash = await post({ path: clashDir })
  score.check(
    "a source bringing an already-mounted cube name is refused",
    clash.status === 400 && String(clash.body?.message).includes("share a name"),
    `http=${clash.status} - refused before the copy, so the duplicate never reaches the next boot`,
  )

  const byReader = await post({ path: goodDir }, reader.headers)
  score.check("a reader cannot use the door at all", byReader.status === 403, `http=${byReader.status}`)

  // 1b. the attacks the review added: symlink root, plain file, FIFO, ghost cube.
  for (const v of await reviewAttacks({ api, admin: adminHeaders, store, fixtures }))
    score.check(v.name, v.ok, v.detail)

  score.check(
    "every refusal above left the store empty - rollback leaves no partial shelf",
    (await api.call("/settings/packages", { headers: adminHeaders })).body?.length === 0,
    "a failed stage that leaves bytes behind makes the next attempt mean something else",
  )
  score.check("and nothing landed in core/plugins", !existsSync(join(pluginsDir, "dirplugin")))

  // ============ 2. the happy path: install from the pointed directory ============

  const installed = await post({ path: goodDir })
  score.check(
    "install-from a valid directory returns 200, staged=true, requiresRestart",
    installed.status === 200 && installed.body?.staged === true && installed.body?.requiresRestart === true,
    `http=${installed.status} staged=${installed.body?.staged}`,
  )
  score.check(
    "the source was staged into the store",
    existsSync(join(store, "dirplugin", "qwbe-package.json")),
    `${store}/dirplugin`,
  )
  score.check(
    "provenance was written in the store - but NOT copied into the installed plugin",
    existsSync(join(store, "dirplugin", "qwbe-source.json")) &&
      !existsSync(join(pluginsDir, "dirplugin", "qwbe-source.json")),
    "the path it came from is store bookkeeping, not the plugin's business",
  )
  score.check(
    "the package manifest did not leak into the installed directory either",
    !existsSync(join(pluginsDir, "dirplugin", "qwbe-package.json")),
  )

  // 2b. drift while it waits: the banner must say "on disk, not mounted".
  verdicts.push(await driftSpeaks({ api, admin: adminHeaders }))

  // 2c. the CLI twin calls the same kernel function.
  verdicts.push(await cliTwinSpeaks({ api, admin: adminHeaders }))

  // ============ 3-5. ownership, idempotence, cycles - in install-from-life.mjs ============
  verdicts.push(...(await shelfAndCycles({ api, admin: adminHeaders, store, goodDir, rivalDir })))

  await stopServer(server)

  // ============ 6. it really works after a restart - mounted, endpoints live ============
  verdicts.push(...(await mountedLife({ dataDir, store, goodDir })))
} finally {
  rmSync(join(pluginsDir, "dirplugin"), { recursive: true, force: true })
  rmSync(join(pluginsDir, PKG), { recursive: true, force: true })
  rmSync(store, { recursive: true, force: true })
  rmSync(sources, { recursive: true, force: true })
  rmSync(fixtures.rivalRoot, { recursive: true, force: true })
  dropScratch(dataDir)
}

const after = fingerprint()
const changed = [...after].filter(([p, h]) => before.get(p) !== h).map(([p]) => p)
const vanished = [...before.keys()].filter((p) => !after.has(p))
score.check(
  "the source tree is byte-for-byte what it was before this probe ran",
  changed.length === 0 && vanished.length === 0,
  `${before.size} files fingerprinted, ${changed.length} altered, ${vanished.length} missing`,
)

for (const v of verdicts) score.check(v.name, v.ok, v.detail)

process.exit(score.report("Install-from probe"))
