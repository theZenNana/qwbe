// Entry point: `npm run setup`. Stdlib only: on a fresh clone core/node_modules is missing, and
// setup.ts needs effect from it. Installs core once if effect is absent, then runs setup.ts.
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

// Same rule as withoutAllowScripts in process-pure.ts, which a .mjs cannot import.
const withoutAllowScripts = (env) =>
  Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== "npm_config_allow_scripts"))

const core = fileURLToPath(new URL("../..", import.meta.url))
const env = withoutAllowScripts(process.env)

// The exit status of one command run in core; a signal or a failed spawn counts as 1.
const run = (command, args) => spawnSync(command, args, { cwd: core, env, stdio: "inherit" }).status ?? 1

const installed = existsSync(`${core}node_modules/effect`) ? 0 : run("npm", ["ci", "--no-audit", "--no-fund"])
process.exitCode = installed === 0 ? run(process.execPath, ["tools/setup/setup.ts"]) : installed
