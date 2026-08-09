// Every cube must carry unit tests. This is the gate that says so out loud.
//
// The owner's rule: unit tests are obligatory, and a cube missing them has to be SEEN — not
// discovered months later when something breaks. Nothing in the build noticed before: probes
// exercise the running system, so a cube with no test of its own still made the suite green.
//
// Same shape as the size caps. What is untested today is recorded as a baseline, printed every
// run as debt, and does not fail the build; a NEW cube without tests, or a cube that LOSES its
// tests, goes red immediately. The debt list is the work queue.
//
//   node probes/testgate.mjs                    report; fail on new gaps
//   node probes/testgate.mjs --strict           fail on every untested unit
//   node probes/testgate.mjs --update-baseline  re-record the debt after a deliberate change
//
// `--update-baseline` goes through the SAME guards as the size caps (`size-guards.mjs`): not from
// a linked worktree, not from a dirty tree, not where there is no repository. The reason is this
// gate's own arithmetic: run from a checkout that sees 12 units, it would drop the 8 that live in
// another one — and those come back later as NEW untested units, on work nobody touched. Same
// damage the size baseline had, one gate over.

import { readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { mayRewriteBaseline } from "./size-guards.mjs"
import { IS_TEST, posix, unitDirs, walk } from "./size-lib.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const configPath = join(root, "qwbe.config.json")

const config = JSON.parse(readFileSync(configPath, "utf8"))
const baseline = config.untestedBaseline ?? { _comment: "", units: [] }

const args = new Set(process.argv.slice(2))
const strict = args.has("--strict")
const updating = args.has("--update-baseline")

const units = unitDirs(root).map(({ id, name, dir }) => {
  const all = walk(dir, { includeTests: true }).map((f) => posix(relative(root, f)))
  const tests = all.filter((f) => IS_TEST.test(basename(f)))
  return { id, name, dir: posix(relative(root, dir)), sources: all.length - tests.length, tests }
})

const untested = units.filter((u) => u.sources > 0 && u.tests.length === 0)

if (updating) {
  const may = mayRewriteBaseline(root)
  if (!may.ok) {
    console.error(may.reason)
    process.exit(1)
  }

  // A unit this checkout cannot see is not a unit that gained tests — it is one we did not look
  // at. Dropping it here is how the debt list would quietly turn into eight new failures at
  // someone else's commit, so unseen entries are KEPT and the fact is printed.
  const seen = new Set(units.map((u) => u.id))
  const kept = (baseline.units ?? []).filter((id) => !seen.has(id))
  const next = {
    ...config,
    untestedBaseline: {
      _comment:
        "Units that had no unit tests when the gate was introduced (2 Aug 2026). This is a work queue, not a permission: a NEW cube without tests fails the build regardless. Shrinking this list is the job; growing it requires --update-baseline, which is a visible diff.",
      units: [...untested.map((u) => u.id), ...kept].sort(),
    },
  }
  writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8")
  console.log(`Untested baseline rewritten in ${posix(relative(root, configPath))}: ${untested.length} units.`)
  for (const id of kept) console.log(`  kept — not in this checkout: ${id}`)
  process.exit(0)
}

const excused = new Set(strict ? [] : (baseline.units ?? []))
const failures = untested.filter((u) => !excused.has(u.id))
const debt = untested.filter((u) => excused.has(u.id))
const tested = units.filter((u) => u.tests.length > 0)

// A unit that WAS excused and now has tests should leave the list — otherwise the baseline
// stops being a work queue and becomes a permanent exemption, which is how these rot.
const stale = [...excused].filter((id) => tested.some((u) => u.id === id))

console.log("")
console.log(
  `Unit-test gate — ${tested.length} of ${units.filter((u) => u.sources > 0).length} units have tests${strict ? " · STRICT (baseline ignored)" : ""}`,
)
console.log("")

for (const u of tested) {
  console.log(`  ✓ ${u.name} — ${u.tests.length} test file${u.tests.length === 1 ? "" : "s"}`)
}
console.log("")

if (stale.length > 0) {
  console.log(`Baseline is stale — these now have tests and should be removed from untestedBaseline:`)
  for (const id of stale) console.log(`  · ${id}`)
  console.log("  Run: node probes/testgate.mjs --update-baseline")
  console.log("")
}

if (debt.length > 0) {
  console.log(`Untested — ${debt.length} unit${debt.length === 1 ? "" : "s"} carried as debt:`)
  for (const u of debt) console.log(`  · ${u.name} (${u.dir})`)
  console.log("")
}

if (failures.length > 0) {
  console.log(`NO UNIT TESTS — ${failures.length} unit${failures.length === 1 ? "" : "s"}:`)
  for (const u of failures) {
    console.log(`  ✗ ${u.name} — ${u.sources} source file${u.sources === 1 ? "" : "s"}, no *.test.ts in ${u.dir}`)
  }
  console.log("")
  console.log("A cube ships with its own tests. Add <name>.test.ts next to the code and run `npm test`.")
  console.log("")
  process.exit(1)
}

console.log(
  debt.length > 0
    ? `Unit-test gate: no NEW gap. ${debt.length} untested unit${debt.length === 1 ? "" : "s"} inherited — run with --strict to see them fail.\n`
    : "Unit-test gate: every unit has tests.\n",
)
process.exit(0)
