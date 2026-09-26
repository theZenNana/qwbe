import * as Path from "@effect/platform/Path"
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Effect from "effect/Effect"
import { loadConfig } from "./config.ts"
import { commands, findings, type Gate, runGates } from "./gate.ts"
import { gitLines } from "./git.ts"
import { untested } from "./testgate.ts"
import { untrackedUnits } from "./untracked.ts"

// node:test files only: core/tools and core/checks run under vitest.
const NODE_TESTS = ["core/src/**/*.test.ts", "core/plugins/**/*.test.ts", "web/**/*.test.ts"]
const VITEST = ["node", "core/node_modules/vitest/vitest.mjs", "run", "--config", "core/vitest.config.ts"] as const
const GITLEAKS = ["gitleaks", "git", ".", "--log-opts=origin/main..HEAD", "--no-banner"] as const

const gates = (root: string, excused: ReadonlyArray<string>): ReadonlyArray<Gate<NodeContext.NodeContext>> => [
  { name: "typecheck", problems: commands(root, ["npx", "tsc", "--noEmit", "-p", "core/tsconfig.json"]) },
  {
    name: "typecheck:web",
    problems: commands(
      root,
      ["npm", "ls", "--prefix", "web", "--depth=0"],
      ["npx", "tsc", "--noEmit", "-p", "web/tsconfig.json"],
    ),
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
  {
    name: "secrets",
    // Tracked files only: local scratch that git ignores never leaves the machine.
    problems: gitLines(root, "ls-files").pipe(
      Effect.flatMap((files) => commands(root, ["npx", "secretlint", ...files], GITLEAKS)),
      Effect.catchAll((error) => Effect.succeed([String(error)])),
    ),
  },
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

const main = Effect.gen(function* () {
  const path = yield* Path.Path
  const root = path.resolve(import.meta.dirname, "../..")
  const config = yield* loadConfig(path.join(root, "qwbe.yaml"))
  const red = yield* runGates(gates(root, process.argv.includes("--strict") ? [] : config.untested))
  if (red.length > 0) process.exitCode = 1
})

if (process.argv[1] === import.meta.filename) NodeRuntime.runMain(main.pipe(Effect.provide(NodeContext.layer)))
