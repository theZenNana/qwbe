import { gateFindings, type Step } from "./steps.ts"

export type GateSpec = { readonly name: string; readonly steps: ReadonlyArray<Step> }

// The gate list, in run order.
export const GATES: ReadonlyArray<GateSpec> = [
  { name: "typecheck", steps: [["npm", "run", "typecheck"]] },
  {
    name: "typecheck:web",
    steps: [
      ["npm", "ls", "--prefix", "web", "--depth=0"],
      ["npx", "tsc", "--noEmit", "-p", "web/tsconfig.json"],
    ],
  },
  {
    name: "lint",
    steps: [
      ["npx", "biome", "check", "."],
      ["npx", "eslint", "."],
    ],
  },
  {
    name: "test",
    steps: [
      ["node", "--test", "core/src/**/*.test.ts", "core/plugins/**/*.test.ts", "web/**/*.test.ts"],
      ["npm", "--prefix", "core", "test"],
    ],
  },
  { name: "boundaries", steps: [["npm", "run", "boundaries"]] },
  { name: "testgate", steps: ["testgate"] },
  { name: "untracked", steps: ["untracked"] },
  {
    name: "secrets",
    steps: ["secretlint", ["gitleaks", "git", ".", "--log-opts=origin/main..HEAD", "--no-banner", "--redact"]],
  },
  {
    name: "audit",
    steps: [
      ["npm", "audit"],
      ["npm", "--prefix", "core", "audit"],
      ["npm", "--prefix", "web", "audit"],
    ],
  },
]

// Opt-in gates, after the list above: `--live` boots real servers, `--bench` runs minutes of
// benchmarks against the budgets in qwbe.yaml. Plain `check` runs neither.
const LIVE: GateSpec = { name: "live", steps: [["npm", "--prefix", "core", "run", "test:live"]] }
const BENCH: GateSpec = { name: "bench", steps: ["bench"] }

export const gateList = (live: boolean, bench: boolean): ReadonlyArray<GateSpec> => [
  ...GATES,
  ...(live ? [LIVE] : []),
  ...(bench ? [BENCH] : []),
]

// Every gate `check` runs, each bound to the repo at `root`; `excused` holds the units allowed to lack tests.
export const gatesFor = (root: string, excused: ReadonlyArray<string>, live: boolean, bench: boolean) =>
  gateList(live, bench).map(({ name, steps }) => ({ name, findings: gateFindings(root, excused, steps) }))
