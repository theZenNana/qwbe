#!/usr/bin/env node
// `--update-baseline` must not forget what it cannot see.
//
// The baseline records debt per file. Rebuilding it walks the checkout — so anything NOT in the
// checkout is, to that walk, indistinguishable from deleted. Untracked work in another worktree
// is exactly that: invisible. On 3 Aug 2026 six baseline entries were read as dead files and
// nearly regenerated away; all six were live, uncommitted work sitting in another checkout, and
// three of them had already grown past their cap. Had the caps been dropped, the gate would have
// turned red on those files the day they were committed — pointing at an author who changed
// nothing, for a reason nobody could reconstruct.
//
// So the rule is: a cap disappears only when the file was MEASURED and found under the cap.
// Never because the walk failed to find it. This probe holds that line.
//
// Real files in a real temp tree, no git, no mocks — the failure being guarded against is a file
// that isn't there, and you cannot fake an absence convincingly enough to trust the test.
//
//   node probes/sizecaps-baseline.mjs

import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const CAP = 6000

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`)
}

// A tree the tool can walk: its own copy of the gate, and one probe file big enough to be over cap.
const GATE_FILES = ["sizecaps.mjs", "size-lib.mjs", "size-guards.mjs"]

const tree = mkdtempSync(join(tmpdir(), "sizecaps-baseline-"))
mkdirSync(join(tree, "probes"), { recursive: true })
for (const f of GATE_FILES) copyFileSync(join(root, "probes", f), join(tree, "probes", f))

const filler = (chars) => `const x = "${"a".repeat(Math.max(0, chars - 16))}"\n`
writeFileSync(join(tree, "probes", "big.mjs"), filler(9000), "utf8")
writeFileSync(join(tree, "probes", "shrunk.mjs"), filler(500), "utf8")

// Three entries, three fates: one grew and is here, one shrank and is here, one is NOT here at all.
const before = {
  caps: { maxCharsPerFile: CAP, maxCharsPerUnit: 40000, maxFilesPerUnit: 15 },
  countMode: "code",
  baseline: {
    _comment: "probe fixture",
    files: {
      "probes/gone-from-this-checkout.mjs": 15940,
      "probes/big.mjs": 7000,
      "probes/shrunk.mjs": 8000,
    },
    units: {},
  },
}
// The gate reads its config from core/ (the qwbe-core package root) -- same layout as the repo.
mkdirSync(join(tree, "core"), { recursive: true })
writeFileSync(join(tree, "core", "qwbe.config.json"), `${JSON.stringify(before, null, 2)}\n`, "utf8")

const output = execFileSync("node", [join(tree, "probes", "sizecaps.mjs"), "--update-baseline"], { encoding: "utf8" })
const after = JSON.parse(readFileSync(join(tree, "core", "qwbe.config.json"), "utf8")).baseline.files

console.log("\n`--update-baseline` run in a checkout that is missing one of the recorded files\n")

const invisible = "probes/gone-from-this-checkout.mjs"
check(
  "a cap for a file this checkout cannot see SURVIVES",
  after[invisible] === before.baseline.files[invisible],
  `${invisible} — ${after[invisible] ?? "DROPPED"}`,
)
check(
  "and the run says so out loud",
  output.includes(`kept — not in this checkout: ${invisible}`),
  "printed, not silent",
)
check(
  "a file that is here and still over cap is re-recorded at its real size",
  after["probes/big.mjs"] > CAP && after["probes/big.mjs"] !== before.baseline.files["probes/big.mjs"],
  `probes/big.mjs — ${before.baseline.files["probes/big.mjs"]} → ${after["probes/big.mjs"]}`,
)
check(
  "a file that is here and dropped under the cap loses its entry — measured, not guessed",
  !("probes/shrunk.mjs" in after),
  "probes/shrunk.mjs — gone, because it was seen and found small",
)

// --- the two refusals: a tree that cannot see everything, and one that would freeze unsaved work ---
//
// Real git repositories in a temp dir, real commits, a real linked worktree. The guards read the
// working tree and `.git` itself, so anything short of the real thing tests the mock, not the gate.

const git = (cwd, ...argv) => execFileSync("git", argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })

const repo = mkdtempSync(join(tmpdir(), "sizecaps-guards-"))
mkdirSync(join(repo, "probes"), { recursive: true })
for (const f of GATE_FILES) copyFileSync(join(root, "probes", f), join(repo, "probes", f))
writeFileSync(join(repo, "probes", "big.mjs"), filler(9000), "utf8")
mkdirSync(join(repo, "core"), { recursive: true })
writeFileSync(join(repo, "core", "qwbe.config.json"), `${JSON.stringify(before, null, 2)}\n`, "utf8")
git(repo, "init", "-q")
git(repo, "add", "-A")
git(repo, "-c", "user.name=probe", "-c", "user.email=probe@local", "commit", "-qm", "fixture")

const run = (cwd, ...argv) => {
  try {
    return { code: 0, out: execFileSync("node", [join(cwd, "probes", "sizecaps.mjs"), ...argv], { encoding: "utf8" }) }
  } catch (err) {
    return { code: err.status, out: `${err.stdout ?? ""}${err.stderr ?? ""}` }
  }
}
const configOf = (cwd) => readFileSync(join(cwd, "core", "qwbe.config.json"), "utf8")

console.log("\nthe two refusals, on real git trees\n")

// Clean tree: the command must still work, or the guards have made it useless.
const clean = run(repo, "--update-baseline")
check("a clean checkout still rewrites the baseline", clean.code === 0, "guards refuse, they do not block")

// Dirty tree: uncommitted work would be measured into the caps.
writeFileSync(join(repo, "probes", "grown.mjs"), filler(7000), "utf8")
const snapshot = configOf(repo)
const dirty = run(repo, "--update-baseline")
check("a tree with uncommitted work is refused", dirty.code === 1, `exit ${dirty.code}`)
check("and the config is left untouched by the refusal", configOf(repo) === snapshot, "byte-identical")
check(
  "the refusal names what would have been measured",
  dirty.out.includes("probes/grown.mjs"),
  "listed, not just counted",
)

// …unless asked on purpose — and then the file says so.
const forced = run(repo, "--update-baseline", "--dirty-ok")
const recorded = JSON.parse(configOf(repo)).baseline._measuredWithUncommitted ?? []
check("--dirty-ok goes through", forced.code === 0, "deliberate, not blocked")
check(
  "and what was uncommitted is written INTO the file, not just the terminal",
  recorded.includes("probes/grown.mjs"),
  `_measuredWithUncommitted: ${JSON.stringify(recorded)}`,
)

// A linked worktree cannot see other checkouts' untracked work at all.
const linked = join(repo, "..", `${repo.split("/").pop()}-linked`)
git(repo, "worktree", "add", "-q", "--detach", linked)
const fromWorktree = run(linked, "--update-baseline")
check("a linked worktree is refused outright", fromWorktree.code === 1, `exit ${fromWorktree.code}`)
check(
  "and says why, in terms of the thing it cannot see",
  fromWorktree.out.includes("cannot see untracked work in other checkouts"),
  "the reason, not just the refusal",
)

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed} pass, ${failed} fail\n`)
process.exit(failed === 0 ? 0 : 1)
