// The STORE-DRIFT probe - the store must provably hold what its sources hold (QWB-54 ticket 22).
//
//   node probes/store-drift.mjs
//
// Runs the real `qwbe drift` bin against a store planted in temp space, never core/store:
// a shelf staged from a real fixture package passes green; the source moving on, a hand-edited
// shelf, and a shelf without provenance each turn the same command RED with the reason named.
// The fingerprint in qwbe-source.json is written with the kernel's own fingerprint function, so
// what this probe pins is the whole chain: provenance, drift check, bin, exit codes.

import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { PROVENANCE, packageSourceFingerprint } from "../core/src/package-source.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const BIN = join(root, "core", "bin", "qwbe.mjs")
const FIXTURE = join(root, "probes", "fixtures", "guestbook-pack")

const results = []
const check = (name, ok, detail = "") => {
  results.push({ name, ok })
  console.log(`  ${ok ? "ok" : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`)
}
const drift = (store) => spawnSync(process.execPath, [BIN, "drift", store], { encoding: "utf8" })

const base = mkdtempSync(join(tmpdir(), "qwbe-store-drift-probe-"))
process.on("exit", () => rmSync(base, { recursive: true, force: true }))
try {
  process.on("SIGINT", () => process.exit(130))

  // A real package source (the fixture), a shelf copied from it, and provenance written the way
  // staging writes it: source path, fingerprint of the source, moment.
  const source = join(base, "guestbook-pack")
  cpSync(FIXTURE, source, { recursive: true })
  const store = join(base, "store")
  const stage = (name) => {
    const shelf = join(store, name)
    cpSync(source, shelf, { recursive: true })
    return shelf
  }
  const fresh = stage("guestbook-pack")
  writeFileSync(
    join(fresh, PROVENANCE),
    `${JSON.stringify(
      { sourcePath: source, fingerprint: packageSourceFingerprint(source), stagedAt: new Date().toISOString() },
      null,
      2,
    )}\n`,
  )

  const green = drift(store)
  check(
    "a shelf matching its source passes green",
    green.status === 0 && green.stdout.includes("guestbook-pack") && green.stdout.includes("qwbe drift: PASS"),
    `exit ${green.status}`,
  )

  // The source moves on after staging: the shelf is behind, and the check must fall red.
  const cubeIndex = join(source, "cubes", "guestbook", "index.ts")
  writeFileSync(cubeIndex, `${readFileSync(cubeIndex, "utf8")}\n// the repo moved on\n`)
  const behind = drift(store)
  check(
    "a shelf behind its source is refused, with the shelf named",
    behind.status === 1 &&
      behind.stdout.includes("guestbook-pack") &&
      behind.stdout.includes("source changed after staging") &&
      behind.stdout.includes("qwbe drift: FAIL"),
    `exit ${behind.status}`,
  )

  // A hand-edited shelf: the provenance records what WAS staged, the bytes say otherwise.
  const edited = stage("edited-pack")
  writeFileSync(
    join(edited, PROVENANCE),
    `${JSON.stringify(
      { sourcePath: source, fingerprint: packageSourceFingerprint(source), stagedAt: new Date().toISOString() },
      null,
      2,
    )}\n`,
  )
  writeFileSync(join(edited, "cubes", "guestbook", "index.ts"), "// edited in place after staging\n")
  const tampered = drift(store)
  check(
    "a shelf edited after staging is refused",
    tampered.status === 1 && tampered.stdout.includes("store copy was changed after staging"),
    `exit ${tampered.status}`,
  )

  // A shelf with no provenance at all - the hand-made copy this ticket removes - cannot be
  // trusted and is not: red, named.
  stage("anonymous-pack")
  const anonymous = drift(store)
  check(
    "a shelf without provenance is red, not silently trusted",
    anonymous.status === 1 && anonymous.stdout.includes("RED") && anonymous.stdout.includes("staged by hand"),
    `exit ${anonymous.status}`,
  )

  // A shelf that grew tooling state staging never writes (node_modules): the shelf fingerprint
  // skips nothing but the provenance file, so any foreign byte turns the check red even though
  // the source stands still -- a planted node_modules could shadow the kernel's own resolution
  // once installed, and this is the gate that makes it visible.
  const poisoned = stage("poisoned-pack")
  writeFileSync(
    join(poisoned, PROVENANCE),
    `${JSON.stringify(
      { sourcePath: source, fingerprint: packageSourceFingerprint(source), stagedAt: new Date().toISOString() },
      null,
      2,
    )}\n`,
  )
  mkdirSync(join(poisoned, "node_modules", "shadow"), { recursive: true })
  writeFileSync(join(poisoned, "node_modules", "shadow", "index.js"), "module.exports = 1\n")
  const tamperedTooling = drift(store)
  check(
    "a shelf that grew node_modules after staging is refused",
    tamperedTooling.status === 1 && tamperedTooling.stdout.includes("store copy was changed after staging"),
    `exit ${tamperedTooling.status}`,
  )

  const failed = results.filter((r) => !r.ok)
  console.log(
    failed.length === 0
      ? `\nstore-drift: ${results.length} checks, all green`
      : `\nstore-drift: ${failed.length} of ${results.length} checks FAILED`,
  )
  process.exit(failed.length === 0 ? 0 : 1)
} catch (error) {
  console.error(`store-drift probe crashed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
