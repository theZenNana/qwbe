import type { Argv } from "./process.ts"

// A step is a command to run, or the tag of a check that runs in this process.
export type Step = Argv | "testgate" | "untracked" | "secretlint" | "bench"

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
