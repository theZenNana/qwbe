import type * as NodeContext from "@effect/platform-node/NodeContext"
import { commands, findings, type Gate } from "./gate.ts"
import { secretProblems } from "./secrets.ts"
import { untested } from "./testgate.ts"
import { untrackedUnits } from "./untracked.ts"

// node:test files only: core/tools and core/checks run under vitest.
const NODE_TESTS = ["core/src/**/*.test.ts", "core/plugins/**/*.test.ts", "web/**/*.test.ts"]
const VITEST = ["node", "core/node_modules/vitest/vitest.mjs", "run", "--config", "core/vitest.config.ts"] as const
const TSC = ["npx", "tsc", "--noEmit", "-p"] as const

/** Every gate of `check`, in the order they run. `excused` units may lack tests. */
export const gateList = (
  root: string,
  excused: ReadonlyArray<string>,
): ReadonlyArray<Gate<NodeContext.NodeContext>> => [
  { name: "typecheck", problems: commands(root, [...TSC, "core/tsconfig.json"]) },
  {
    name: "typecheck:web",
    problems: commands(root, ["npm", "ls", "--prefix", "web", "--depth=0"], [...TSC, "web/tsconfig.json"]),
  },
  {
    name: "lint",
    problems: commands(root, ["npx", "biome", "check", ".", "--reporter=summary"], ["npx", "eslint", "."]),
  },
  { name: "test", problems: commands(root, ["node", "--test", ...NODE_TESTS], VITEST) },
  { name: "boundaries", problems: commands(root, ["npm", "--prefix", "core", "run", "boundaries"]) },
  { name: "testgate", problems: findings(untested(root, excused), (id) => `${id} has source files and no test`) },
  {
    name: "untracked",
    problems: findings(untrackedUnits(root), (unit) => `${unit} mounts at boot, nothing of it in git`),
  },
  { name: "secrets", problems: secretProblems(root) },
  {
    name: "audit",
    problems: commands(
      root,
      ["npm", "audit"],
      ["npm", "audit", "--prefix", "core"],
      ["npm", "audit", "--prefix", "web"],
    ),
  },
]
