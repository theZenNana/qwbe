#!/usr/bin/env node
// `qwbe check` — one command that runs every gate and says WHAT IS MISSING.
//
// The owner's words (2 Aug 2026): "dacă un cube nu are unit testing-ul, trebuie să vadă
// scriptul efectiv automat, tot. Deci toate chestiile care lipsesc trebuie să fie văzute."
//
// So this is not a runner that chains commands with `&&`. A chain stops at the first failure,
// which means one broken gate hides every gap behind it — you fix the type errors, run again,
// and only then learn that sixteen cubes have no tests. Everything runs, everything is
// reported, and the exit code comes at the end.
//
// What it does NOT do: start a server, call an agent, or guess. Every line is a real process
// with a real exit code. The probes that need a running system stay in `probe:all` on purpose —
// a completeness check people avoid because it takes two minutes stops being run.
//
//   node scripts/check.mjs             every static gate, report, exit 1 if anything is red
//   node scripts/check.mjs --strict    baselines ignored: inherited debt fails too
//   node scripts/check.mjs --json      the same verdict as data

import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { gatesFor } from "./check-gates.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const args = new Set(process.argv.slice(2))
const strict = args.has("--strict")
const json = args.has("--json")

const run = ([cmd, cmdArgs]) => {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, encoding: "utf8", shell: process.platform === "win32" })
  if (r.error) return { ok: false, out: `nu s-a putut rula ${cmd}: ${r.error.message}`, missing: true }
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}

/** A reader that throws must not take the whole report down with it. */
const safely = (fn, fallback) => {
  try {
    return fn() ?? fallback
  } catch {
    return fallback
  }
}

const results = gatesFor({ strict }).map((gate) => {
  const first = run(gate.command)
  const second = gate.also ? run(gate.also) : null
  const out = second ? `${first.out}\n${second.out}` : first.out
  const ok = first.ok && (second ? second.ok : true)
  const showDetail = gate.detail && (!ok || gate.alwaysShowDetail)
  return {
    id: gate.id,
    fix: gate.fix,
    what: gate.what,
    ok,
    // A gate passes for two very different reasons: nothing is wrong, or everything wrong is
    // frozen in a baseline. The same ✓ for both is how "1 of 17 units have tests" came to look
    // like a pass. `~` says: green today, only because the debt is excused.
    debt: ok && !strict && safely(() => gate.debt?.(out), false),
    missing: first.missing === true,
    summary: safely(() => gate.summary?.(out), ok ? "trece" : "pică"),
    detail: showDetail ? safely(() => gate.detail(out), []) : [],
  }
})

const red = results.filter((r) => !r.ok)
const onDebt = results.filter((r) => r.debt)

if (json) {
  console.log(JSON.stringify({ strict, ok: red.length === 0, gates: results }, null, 2))
  process.exit(red.length === 0 ? 0 : 1)
}

const pad = (s, n) => `${s}`.padEnd(n) + (`${s}`.length >= n ? "  " : "")

console.log(`\nqwbe check${strict ? " — STRICT (baseline-urile nu mai scuză nimic)" : ""}\n`)
for (const r of results) {
  console.log(`  ${r.ok ? (r.debt ? "~" : "✓") : "✗"} ${pad(r.id, 12)}${pad(r.what, 46)}${r.summary}`)
}

const withDetail = results.filter((r) => r.detail.length > 0)
if (withDetail.length > 0) {
  console.log("\nCe lipsește, pe nume:")
  for (const r of withDetail) {
    console.log(`\n  ${r.id} — ${r.what}`)
    for (const line of r.detail) console.log(`    · ${line}`)
  }
}

if (onDebt.length > 0) {
  console.log(
    `\n~ ${onDebt.map((r) => r.id).join(", ")} — trec DOAR pentru că datoria de azi e înghețată în baseline.\n` +
      `  Owner-ul a cerut teste obligatorii; o poartă care trece nu e obligatorie.\n` +
      `  \`node scripts/check.mjs --strict\` le arată cum sunt de fapt.`,
  )
}

if (red.length === 0) {
  console.log(`\nVerde. ${results.length} porți, toate trec.${onDebt.length > 0 ? "  (vezi nota de mai sus)" : ""}\n`)
  process.exit(0)
}

console.log(`\nROȘU — ${red.length} din ${results.length} porți pică: ${red.map((r) => r.id).join(", ")}`)
console.log(`Ieșirea completă: ${red.map((r) => `npm run ${r.fix}`).join(" · ")}\n`)
process.exit(1)
