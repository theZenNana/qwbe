// The LIFECYCLE probe — a package's whole life, twice, with the same verdicts both times.
//
//   node probes/lifecycle.mjs
//
// The install probe proves that installing is *safe* (60-odd refused attacks, no existing file
// touched). It does not prove the thing a person actually does: install a package, restart,
// use it, change their mind, uninstall, restart, and still have a working application. Every
// step of that was verified by hand at some point and by nothing afterwards.
//
// What this one guards, in order:
//
//   1. installing does NOT mount — the response says `requiresRestart`, and the cubes really
//      are still absent until the process is restarted. A promise that is kept is not the same
//      as a promise that is checked.
//   2. after a restart the cubes are mounted AND usable — a row written and read back, not a
//      name appearing in a catalogue.
//   3. uninstalling a package leaves the running server alone: the cubes it already mounted
//      keep answering until the restart. Half-deleted state is where applications crash.
//   4. after that restart the routes are gone with a 404 and the application is still up:
//      login works, the catalogue answers. "Gone" must not mean "broken".
//   5. CRM and ERP both bring a cube called `contacts`. The second install is refused with a
//      message naming the clash, and the first package is left exactly as it was.
//
// Determinism, since that was the ask: no clock, no random, no reliance on what happens to be
// on disk. Whatever is installed when this starts is moved aside into a temporary directory and
// moved back in `finally` — restored from that copy, never from git. (Restoring with
// `git checkout` is how an earlier probe silently threw away uncommitted work.) A SHA-256
// fingerprint of the source tree is taken before and compared after; if a single byte differs,
// this probe says so and fails.
//
// The steps themselves are in `lifecycle-life.mjs`, and the bench they run on — paths, the
// fingerprint, the parking lot — in `lifecycle-bench.mjs`. This file is what runs twice and
// compares.

import { rmSync } from "node:fs"
import { makeScore } from "./lib.mjs"
import { clearTheBench, fingerprint, parking, putBack } from "./lifecycle-bench.mjs"
import { liveAndDie } from "./lifecycle-life.mjs"

const score = makeScore()

const before = fingerprint()

try {
  clearTheBench()

  const first = await liveAndDie(1)
  const second = await liveAndDie(2)

  for (const v of [...first, ...second]) score.check(v.name, v.ok, v.detail)

  const shape = (list) => list.map((v) => `${v.name.replace(/^pass \d+: /, "")}=${v.ok}`).join("|")
  score.check(
    "the same package lived and died twice with identical verdicts",
    first.length === second.length && shape(first) === shape(second),
    `${first.length} steps each — a probe that only passes on a clean machine is not a probe`,
  )
} finally {
  putBack()
  rmSync(parking, { recursive: true, force: true })
}

const after = fingerprint()
const changed = [...after].filter(([p, h]) => before.get(p) !== h).map(([p]) => p)
const vanished = [...before.keys()].filter((p) => !after.has(p))

score.check(
  "the source tree is byte-for-byte what it was before this probe ran",
  changed.length === 0 && vanished.length === 0,
  `${before.size} files fingerprinted, ${changed.length} altered, ${vanished.length} missing` +
    (changed.length || vanished.length ? ` — ${[...changed, ...vanished].slice(0, 4).join(", ")}` : ""),
)

process.exit(score.report("Lifecycle probe"))
