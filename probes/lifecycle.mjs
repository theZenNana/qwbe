// The LIFECYCLE probe - a package's whole life, twice, with the same verdicts both times.
//
//   node probes/lifecycle.mjs
//
// The install probe proves that installing is *safe* (60-odd refused attacks, no existing file
// touched). It does not prove the thing a person actually does: install a package, restart,
// use it, change their mind, uninstall, restart, and still have a working application.
//
// What this one guards, in order:
//
//   1. installing does NOT mount - the response says `requiresRestart`, and the cube really is
//      still absent until the process is restarted. A promise that is kept is not the same as a
//      promise that is checked.
//   2. after a restart the cube is mounted AND usable - a row written and read back, not a name
//      appearing in a catalogue.
//   3. uninstalling the package leaves the running server alone: the routes it already mounted
//      keep answering until the restart. Half-deleted state is where applications crash.
//   4. after that restart the routes are gone with a 404 and the application is still up:
//      login works, the catalogue answers. "Gone" must not mean "broken".
//
// The package under test is a renamed copy of example-plugin, planted in a temp store by
// `lifecycle-bench.mjs`. The install step writes the copy
// into `core/plugins/lifecycle-plugin/` - a directory the repo never had - and the uninstall
// step takes it back off. Nothing committed is ever deleted; a SHA-256 fingerprint of the
// source tree before and after proves the probe left nothing behind.
//
// Determinism, since that was the ask: no clock, no random, no reliance on what happens to be
// on disk. The store is planted fresh each run, and the fingerprint comparison is the verdict.

import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { makeScore } from "./lib.mjs"
import { fingerprint, PKG, plantLifecycleStore, pluginsDir } from "./lifecycle-bench.mjs"
import { liveAndDie } from "./lifecycle-life.mjs"

const score = makeScore()

// The install step WRITES `core/plugins/lifecycle-plugin/` and the uninstall step DELETES it.
// A directory with that name that the probe did not plant is the owner's work, and the probe
// has no way to tell it apart - so it refuses to run rather than risk deleting it.
const installTarget = join(pluginsDir, PKG)
if (existsSync(installTarget)) {
  console.error(
    `refused: ${installTarget} already exists and was not planted by this probe. Remove or rename it first.`,
  )
  process.exit(1)
}

const before = fingerprint()
const store = plantLifecycleStore()

try {
  const first = await liveAndDie(1, store)
  const second = await liveAndDie(2, store)

  for (const v of [...first, ...second]) score.check(v.name, v.ok, v.detail)

  const shape = (list) => list.map((v) => `${v.name.replace(/^pass \d+: /, "")}=${v.ok}`).join("|")
  score.check(
    "the same package lived and died twice with identical verdicts",
    first.length === second.length && shape(first) === shape(second),
    `${first.length} steps each - a probe that only passes on a clean machine is not a probe`,
  )
} finally {
  rmSync(store, { recursive: true, force: true })
}

const after = fingerprint()
const changed = [...after].filter(([p, h]) => before.get(p) !== h).map(([p]) => p)
const vanished = [...before.keys()].filter((p) => !after.has(p))

score.check(
  "the source tree is byte-for-byte what it was before this probe ran",
  changed.length === 0 && vanished.length === 0,
  `${before.size} files fingerprinted, ${changed.length} altered, ${vanished.length} missing` +
    (changed.length || vanished.length ? ` - ${[...changed, ...vanished].slice(0, 4).join(", ")}` : ""),
)

process.exit(score.report("Lifecycle probe"))
