// The gates `qwbe check` runs, and how to read each one's output.
//
// Split out of check.mjs because check.mjs went over the character cap the moment it was
// written — 6107 against a cap of 6000, caught by the repository's own `sizecaps` gate on its
// first run. Raising the cap for the file that reports cap violations would have been the
// funniest possible way to make the rule meaningless, so the file split instead. That is
// exactly what the rule asks of every other unit here.
//
// Each gate is a real process with a real exit code. `summary` reduces its output to the one
// number worth reading; `detail` names what is missing; `debt` says whether a pass is a genuine
// pass or only a frozen baseline. A gate whose output shape changes still reports pass/fail
// honestly — the readers are convenience, never the verdict.

/** @param {{ strict: boolean }} options */
export const gatesFor = ({ strict }) => [
  {
    id: "typecheck",
    fix: "typecheck",
    what: "tipurile se verifică (tsc --noEmit)",
    command: ["npx", ["tsc", "--noEmit", "-p", "core/tsconfig.json"]],
    summary: (out) => {
      const errors = out.match(/error TS\d+/g) ?? []
      return errors.length === 0 ? "fără erori de tip" : `${errors.length} erori de tip`
    },
    detail: (out) =>
      [...new Set(out.match(/^[^\s(]+\.tsx?/gm) ?? [])].slice(0, 12).map((f) => `fișier cu erori de tip: ${f}`),
  },
  {
    id: "lint",
    fix: "lint",
    what: "Biome (format + reguli) și ESLint type-aware",
    // `--reporter=summary` rather than the default: the default prints one block per finding and
    // truncates at 20, so counting its lines undercounts by whatever it dropped. The summary
    // reporter lists every file needing formatting and every rule with its tally.
    command: ["npx", ["biome", "check", ".", "--reporter=summary"]],
    also: ["npx", ["eslint", "."]],
    summary: (out) => {
      const errors = /Found (\d+) errors?/.exec(out)?.[1] ?? "0"
      const block = /need to be formatted:([\s\S]*?)reporter\/violations/.exec(out)?.[1] ?? ""
      const files = (block.match(/^\s+- \S+/gm) ?? []).length
      const eslint = /✖ (\d+) problems? \((\d+) errors?/.exec(out)
      return (
        `${errors} constatări Biome` +
        (files > 0 ? `, ${files} fișiere de formatat` : "") +
        (eslint ? `, ${eslint[2]} erori ESLint` : ", 0 erori ESLint")
      )
    },
    detail: (out) =>
      (out.match(/^\s+(?:lint|assist)\/\S+\s+\d+ \(.+\)$/gm) ?? []).map((l) => l.trim().replace(/\s+/g, " ")),
  },
  {
    // `typecheck` de deasupra acoperă DOAR `core/` — numele promitea mai mult decât făcea
    // comanda, iar `web/` (20+ fișiere TypeScript) n-avea nicio poartă. Costul, măsurat pe
    // 3 aug: un `type="button"` scris de două ori pe același element a trecut de biome, de 187
    // de teste, de sizecaps și de toate cele 8 porți; îl vedea numai `tsc` pe web.
    id: "typecheck:web",
    fix: "typecheck:web",
    what: "tipurile din web/ se verifică (cere `npm ci --prefix web`)",
    command: ["node", ["scripts/typecheck-web.mjs"]],
    summary: (out) => {
      if (out.includes("npm ci --prefix web")) return "node_modules lipsă sau învechit — npm ci --prefix web"
      const n = (out.match(/error TS/g) ?? []).length
      return n === 0 ? "0 erori" : `${n} erori`
    },
  },
  // AICI A FOST poarta `randare`, scoasă pe 9 aug 2026 odată cu cubul `reports`.
  //
  // Verifica, într-un Chrome adevărat, că randarea de markdown scapă HTML-ul — 12 verificări,
  // rupte dinadins la scriere ca să se dovedească faptul că pot pica. Era singurul spec Playwright
  // din lanț, fiindcă nu pornea niciun server (`page.setContent`, 2,4 secunde).
  //
  // A plecat pentru că a plecat codul pe care-l apăra: `web/app/reports/markdown.ts` nu mai există,
  // iar o poartă care nu are ce verifica e doar timp de rulare. Se pune la loc împreună cu prima
  // suprafață care randează text scris de altcineva — și atunci se rupe din nou dinadins, ca să se
  // vadă că prinde. Codul plecat e în istorie, la `de82d46`.
  {
    id: "test",
    fix: "test",
    what: "testele unitare trec",
    command: ["node", ["--test", "core/**/*.test.ts", "web/**/*.test.ts"]],
    summary: (out) => {
      const pass = /^# pass (\d+)$/m.exec(out)?.[1] ?? /pass (\d+)/.exec(out)?.[1] ?? "?"
      const fail = /^# fail (\d+)$/m.exec(out)?.[1] ?? /fail (\d+)/.exec(out)?.[1] ?? "?"
      return `${pass} trec, ${fail} pică`
    },
  },
  {
    id: "testgate",
    fix: "probe:testgate",
    what: "fiecare cub are teste unitare",
    command: ["node", ["probes/testgate.mjs", ...(strict ? ["--strict"] : [])]],
    summary: (out) => /(\d+) of (\d+) units have tests/.exec(out)?.[0] ?? "necunoscut",
    debt: (out) => /no NEW gap|inherited/i.test(out),
    // The whole point of the owner's request: the units WITHOUT tests, by name, every run —
    // whether the gate is red or green. A debt nobody reads is a debt nobody pays.
    detail: (out) => (out.match(/^ {2}· (?:cube|space) .+$/gm) ?? []).map((l) => l.replace(/^ {2}· /, "fără teste: ")),
    alwaysShowDetail: true,
  },
  {
    id: "sizecaps",
    fix: "probe:sizecaps",
    what: "niciun cub și niciun fișier peste capul de dimensiune",
    command: ["node", ["probes/sizecaps.mjs", ...(strict ? ["--strict"] : [])]],
    summary: (out) => {
      const debt = /Inherited debt — (\d+) over cap/.exec(out)?.[1]
      const fresh = /OVER CAP — (\d+) problem/.exec(out)?.[1]
      return [fresh ? `${fresh} peste cap acum` : "nimic nou peste cap", debt ? `${debt} datorie veche` : null]
        .filter(Boolean)
        .join(", ")
    },
    debt: (out) => /no NEW violation|Inherited debt/i.test(out),
    detail: (out) => (out.match(/^ {2}✗ .+$/gm) ?? []).map((l) => l.replace(/^ {2}✗ /, "peste cap: ")),
  },
  {
    id: "untracked",
    fix: "probe:untracked",
    what: "tot ce se montează e și în git",
    command: ["node", ["probes/untracked.mjs"]],
    summary: (out) =>
      /Cod viu care nu e în git — (\d+) unit\S+/.exec(out)?.[0].replace("Cod viu care nu e în git — ", "") ??
      "necunoscut",
    detail: (out) => (out.match(/^ {2}✗ .+$/gm) ?? []).map((l) => l.replace(/^ {2}✗ /, "netrackuit: ")),
  },
  {
    id: "boundaries",
    fix: "boundaries",
    what: "granițele între cuburi (dependency-cruiser)",
    command: ["npm", ["--prefix", "core", "run", "boundaries"]],
    summary: (out) => {
      const v = /(\d+) dependency violations/.exec(out)
      return v ? `${v[1]} violări` : "fără violări"
    },
    detail: (out) => (out.match(/^ *error [a-z-]+: .+$/gm) ?? []).map((l) => l.trim()),
  },
]
