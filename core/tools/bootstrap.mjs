// Entry point: `npm run setup`. Stdlib only: on a fresh clone core/node_modules is missing, and
// setup.ts needs effect from it. Installs core once if effect is absent, then runs setup.ts.
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

// Same rule as withoutAllowScripts in process-pure.ts, which a .mjs cannot import.
const withoutAllowScripts = (env) =>
  Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== "npm_config_allow_scripts"))

const needsInstall = (effectPresent) => !effectPresent

const runnerIn = (cwd, env) => (command, args) => spawnSync(command, args, { cwd, env, stdio: "inherit" }).status ?? 1

const bootstrap = (run, effectPresent, nodePath) => {
  const installed = needsInstall(effectPresent) ? run("npm", ["ci", "--no-audit", "--no-fund"]) : 0
  return installed === 0 ? run(nodePath, ["tools/setup.ts"]) : installed
}

const core = fileURLToPath(new URL("..", import.meta.url))
process.exitCode = bootstrap(
  runnerIn(core, withoutAllowScripts(process.env)),
  existsSync(`${core}node_modules/effect`),
  process.execPath,
)
