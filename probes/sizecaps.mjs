// Size caps — the rule ported from software-factory (ADR-0006: "splitting is driven by size,
// measured in characters"), applied to qwbe's cubes.
//
// Why a cap at all: a cube is meant to be one directory you can read in a sitting, delete
// without touching anything else, and hand to someone who has never seen the system. A file
// that grows past a few thousand characters stops being that, and nothing else in the build
// notices — depcruise sees dependencies, not size. So size gets its own gate.
//
// Two numbers per file. `raw` is every byte; `code` is what is left after comments come out.
// They are far apart here ON PURPOSE — the reasoning lives next to the rule, and several files
// are more comment than code. Capping `raw` would make deleting an explanation the cheapest way
// to go green, which is the opposite of the point. So `code` is enforced, `raw` is printed
// beside it, and the choice sits in qwbe.config.json where changing it is a visible diff.
//
// Existing violations are recorded there as a baseline: RED for anything new or anything that
// grew, with the inherited debt printed every run so it cannot be quietly forgotten.
//
// `--update-baseline` writes caps for files that are on DISK, committed or not. That single fact
// is behind all three guards below: a checkout that cannot see a file drops its cap, and a
// checkout with uncommitted work freezes that work into the numbers. Both were live on 3 Aug.
//
//   node probes/sizecaps.mjs                    report; fail on new violations
//   node probes/sizecaps.mjs --strict           fail on everything over cap, baseline included
//   node probes/sizecaps.mjs --update-baseline  re-record the debt after a deliberate change
//   node probes/sizecaps.mjs --update-baseline --dirty-ok   …from a tree with uncommitted work

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { mayRewriteBaseline } from "./size-guards.mjs"
import { measure, posix, unitDirs, walk } from "./size-lib.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
// The config lives in core/ (the qwbe-core package root): the same file the
// installed kernel ships, so a pack checked with `qwbe check` is held to the caps this repo
// holds ITSELF to -- one file, not two copies that can drift.
const configPath = join(root, "core", "qwbe.config.json")

const config = JSON.parse(readFileSync(configPath, "utf8"))
const caps = config.caps
const countMode = config.countMode === "raw" ? "raw" : "code"
const baseline = config.baseline ?? { files: {}, units: {} }

const args = new Set(process.argv.slice(2))
const strict = args.has("--strict")
const updating = args.has("--update-baseline")
const dirtyOk = args.has("--dirty-ok")

const rel = (f) => posix(relative(root, f))

// --- measure ---

const roots = ["core", "web/app", "web/lib", "probes", "scripts"].map((r) => join(root, r))
const fileRows = roots
  .flatMap((r) => walk(r))
  .map((f) => ({ path: rel(f), ...measure(f) }))
  .sort((a, b) => b[countMode] - a[countMode])

const unitRows = unitDirs(root)
  .map(({ id, name, dir }) => {
    const own = walk(dir, { top: false }).map(measure)
    return {
      id,
      name,
      dir: rel(dir),
      files: own.length,
      raw: own.reduce((s, f) => s + f.raw, 0),
      code: own.reduce((s, f) => s + f.code, 0),
    }
  })
  .sort((a, b) => b[countMode] - a[countMode])

const overFiles = fileRows.filter((f) => f[countMode] > caps.maxCharsPerFile)
const overUnits = unitRows.filter((u) => u[countMode] > caps.maxCharsPerUnit || u.files > caps.maxFilesPerUnit)

// --- re-record the debt, when asked deliberately ---

if (updating) {
  // Whether this checkout may record numbers at all — see size-guards.mjs for both refusals and
  // the day they were paid for. `dirty` is what will be measured but is committed nowhere.
  const verdict = mayRewriteBaseline(root, { dirtyOk })
  if (!verdict.ok) {
    console.error(verdict.reason)
    process.exit(1)
  }
  const dirty = verdict.dirty

  // A checkout only sees its own files. Work that is untracked in ANOTHER worktree — or simply
  // not checked out here — is invisible to the walk above, and rebuilding the baseline from what
  // we see would drop its caps without a word. The day that work is committed, the gate turns red
  // on files nobody touched, in a repo where nobody remembers why. So: entries we cannot SEE are
  // kept, and the fact is printed. Forgetting a cap for real is a deliberate edit, done by hand.
  const seenFiles = new Set(fileRows.map((f) => f.path))
  const seenUnits = new Set(unitRows.map((u) => u.id))
  const keptFiles = Object.entries(baseline.files ?? {}).filter(([p]) => !seenFiles.has(p))
  const keptUnits = Object.entries(baseline.units ?? {}).filter(([id]) => !seenUnits.has(id))
  const byCharsDesc = (a, b) => (b[1].chars ?? b[1]) - (a[1].chars ?? a[1])

  const next = {
    ...config,
    baseline: {
      _comment: baseline._comment,
      // A number written from a dirty tree describes one machine on one day, not the repository.
      // Whoever reads it next deserves to know that from the file itself, not from a chat log.
      ...(dirty.length > 0 ? { _measuredWithUncommitted: dirty } : {}),
      files: Object.fromEntries([...overFiles.map((f) => [f.path, f[countMode]]), ...keptFiles].sort(byCharsDesc)),
      units: Object.fromEntries(
        [...overUnits.map((u) => [u.id, { chars: u[countMode], files: u.files }]), ...keptUnits].sort(byCharsDesc),
      ),
    },
  }
  writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8")
  console.log(
    `Baseline rewritten in ${rel(configPath)}: ${overFiles.length} files, ${overUnits.length} units over cap.`,
  )
  for (const [p] of [...keptFiles, ...keptUnits]) console.log(`  kept — not in this checkout: ${p}`)
  if (dirty.length > 0)
    console.log(`  recorded from a DIRTY tree — ${dirty.length} uncommitted path(s), noted in the file`)
  process.exit(0)
}

// --- judge against the baseline ---

const judge = (row, key, was, grew) =>
  strict || was === undefined ? { ...row, kind: "new" } : { ...row, kind: grew ? "grew" : "known", was: key }

const verdicts = [
  ...overFiles.map((f) => {
    const was = baseline.files?.[f.path]
    return judge(f, was, was, f[countMode] > was)
  }),
  ...overUnits.map((u) => {
    const was = baseline.units?.[u.id]
    return judge(u, was, was, was !== undefined && (u[countMode] > was.chars || u.files > was.files))
  }),
]

const failures = verdicts.filter((v) => v.kind !== "known")
const known = verdicts.filter((v) => v.kind === "known")

// --- report ---

const num = (n) => String(n).padStart(6)
const nameOf = (v) => v.path ?? v.name

console.log("")
console.log(
  `Size caps — measuring ${countMode} characters (comments ${countMode === "code" ? "excluded" : "included"})`,
)
console.log(
  `  caps: ${caps.maxCharsPerFile} chars/file · ${caps.maxCharsPerUnit} chars/unit · ${caps.maxFilesPerUnit} files/unit` +
    `${strict ? " · STRICT (baseline ignored)" : ""}`,
)
console.log(`  measured: ${fileRows.length} source files across ${unitRows.length} units (unit tests excluded)`)
console.log("")

console.log("Largest units")
for (const u of unitRows.slice(0, 6)) {
  const flag = u[countMode] > caps.maxCharsPerUnit || u.files > caps.maxFilesPerUnit ? "✗" : "✓"
  console.log(`  ${flag} ${num(u.code)} code ${num(u.raw)} raw ${String(u.files).padStart(3)} files  ${u.name}`)
}
console.log("")

console.log("Largest files")
for (const f of fileRows.slice(0, 6)) {
  const flag = f[countMode] > caps.maxCharsPerFile ? "✗" : "✓"
  console.log(`  ${flag} ${num(f.code)} code ${num(f.raw)} raw  ${f.path}`)
}
console.log("")

if (known.length > 0) {
  console.log(`Inherited debt — ${known.length} over cap, recorded in the baseline, still to split:`)
  for (const v of known) console.log(`  · ${num(v[countMode])} ${nameOf(v)}`)
  console.log("")
}

if (failures.length > 0) {
  console.log(`OVER CAP — ${failures.length} problem${failures.length === 1 ? "" : "s"}:`)
  for (const v of failures) {
    const cap = v.path ? caps.maxCharsPerFile : caps.maxCharsPerUnit
    const grew = v.kind === "grew" ? ` (was ${v.path ? v.was : v.was.chars} when the cap was set)` : ""
    console.log(`  ✗ ${nameOf(v)} — ${v[countMode]} ${countMode} chars, cap is ${cap}${grew}`)
    if (!v.path && v.files > caps.maxFilesPerUnit) {
      console.log(`      and ${v.files} files, cap is ${caps.maxFilesPerUnit}`)
    }
  }
  console.log("")
  console.log("A unit over cap splits in two. Raising the cap is a change to qwbe.config.json — a visible diff.")
  console.log("")
  process.exit(1)
}

console.log(
  known.length > 0
    ? `Size caps: no NEW violation. ${known.length} inherited — run with --strict to see them fail.\n`
    : "Size caps: everything within cap.\n",
)
process.exit(0)
