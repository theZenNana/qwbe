// `npm run setup` on a fresh clone: core/node_modules (and so Effect) does not exist yet, which is
// why this one file uses only the Node standard library. It installs core, then hands over to the
// Effect setup (core/tools/setup.ts) for the Node check, root and web, and data/.
//
// Under `npm run`, npm passes the user's allow-scripts as npm_config_allow_scripts, and npm >= 12
// refuses that in a project-scoped install (EALLOWSCRIPTS); the child npm reads ~/.npmrc itself.

import { spawnSync } from "node:child_process"
import { join } from "node:path"

const root = join(import.meta.dirname, "..", "..")
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "npm_config_allow_scripts"),
)
const run = (bin: string, args: ReadonlyArray<string>) =>
  spawnSync(bin, args, { cwd: root, env, stdio: "inherit", shell: process.platform === "win32" }).status ?? 1

const status = run("npm", ["ci", "--prefix", "core", "--no-audit", "--no-fund"])
process.exitCode = status !== 0 ? status : run(process.execPath, ["core/tools/setup.ts"])
