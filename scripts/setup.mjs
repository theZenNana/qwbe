// One installation step for the whole project.
//
//   npm run setup
//
// Checks the Node version, installs core/ and web/, creates data/. No dependency of its own:
// everything here is stdlib, because the point of this file is to run in a checkout where
// nothing has been installed yet.

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

const bold = (s) => (process.stdout.isTTY ? `[1m${s}[0m` : s)
const step = (n, total, text) => console.log(`\n${bold(`[${n}/${total}]`)} ${text}`)

// --- 1. Node version -------------------------------------------------------------------------
//
// The project executes TypeScript directly. Node 22.18 is the first supported threshold where
// type stripping no longer needs an experimental flag.

const REQUIRED = [22, 18, 0]

const parseVersion = (v) =>
  v
    .replace(/^v/, "")
    .split(".")
    .map((n) => Number.parseInt(n, 10))

const isOlder = (have, want) => {
  for (let i = 0; i < want.length; i++) {
    const h = have[i] ?? 0
    if (h < want[i]) return true
    if (h > want[i]) return false
  }
  return false
}

step(1, 4, "Node version")

const have = parseVersion(process.versions.node)
if (isOlder(have, REQUIRED)) {
  console.error(
    `\nQwbe needs Node ${REQUIRED.join(".")} or newer — you have ${process.versions.node}.\n\n` +
      `  Why: the API and tests execute TypeScript directly through Node type stripping.\n` +
      `  Earlier releases require flags and do not match CI.\n\n` +
      `  Fix: install a newer Node (nvm install 22, or your package manager), then run\n` +
      `  \`npm run setup\` again.\n`,
  )
  process.exit(1)
}
console.log(`      node ${process.versions.node} — ok (need >= ${REQUIRED.join(".")})`)

// --- 2. dependencies -------------------------------------------------------------------------
//
// Three independently locked packages: tooling at root, kernel, and frontend. None imports
// another package, so each uses its own package-lock.json and the same `npm ci` policy.

const npm = process.platform === "win32" ? "npm.cmd" : "npm"

// This file runs *as* an npm script, so npm has flattened the user's ~/.npmrc into the
// environment as `npm_config_*`. One of those entries breaks the npm install we are about to
// run: if the user has `allow-scripts` in their .npmrc, npm >= 12 refuses it when it arrives as
// an environment option in a project-scoped install —
//
//   npm error code EALLOWSCRIPTS
//   npm error --allow-scripts is not allowed in project-scoped installs.
//
// Dropping the variable does not drop the policy: the child npm reads the same ~/.npmrc itself,
// at the scope where the option is legal. Seen on npm 12.0.1; a plain `npm install` in core/
// works, only the nested one fails, which is what makes it worth a comment instead of a shrug.
const childEnv = { ...process.env }
for (const key of Object.keys(childEnv)) {
  if (key.toLowerCase() === "npm_config_allow_scripts") delete childEnv[key]
}

const install = (where) => {
  const dir = join(root, where)
  console.log(`      installing ${where}/ …`)
  const r = spawnSync(npm, ["ci", "--no-audit", "--no-fund"], {
    cwd: dir,
    stdio: "inherit",
    env: childEnv,
  })
  if (r.error) {
    console.error(`\nCould not run \`npm install\` in ${where}/: ${r.error.message}\n`)
    process.exit(1)
  }
  if (r.status !== 0) {
    console.error(`\n\`npm install\` failed in ${where}/ (exit ${r.status}). Nothing else was done.\n`)
    process.exit(r.status ?? 1)
  }
}

step(2, 4, "dependencies")
install(".")
install("core")
install("web")

// --- 3. plugin environments ------------------------------------------------------------------
//
// Deliberately conditional. A plugin can bring any external runtime with it -- an interpreter,
// a virtual environment, its own pinned packages -- and the kernel's standard setup must not
// install any of that: a Qwbe without the plugin has to work, so the plugin's toolchain cannot
// become a requirement of the base install. What setup DOES, when the plugin happens to be on
// disk, is delegate to the plugin's own `setup.mjs`, so an in-repo plugin stays one command to
// install. The plugin owns the command, the versions and the failure messages.

import { readdirSync } from "node:fs"

const pluginsDir = join(root, "core/plugins")
const pluginSetups = existsSync(pluginsDir)
  ? readdirSync(pluginsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(pluginsDir, entry.name, "setup.mjs")))
      .map((entry) => join(pluginsDir, entry.name, "setup.mjs"))
  : []

if (pluginSetups.length === 0) {
  step(3, 4, "plugin environments")
  console.log("      no plugin with its own setup.mjs -- nothing to prepare")
}
for (const [index, setup] of pluginSetups.entries()) {
  step(3 + index, 3 + pluginSetups.length, `plugin environment (${setup.split("/").at(-2)})`)
  const ran = spawnSync(process.execPath, [setup], { stdio: "inherit", env: childEnv })
  if (ran.status !== 0) process.exit(ran.status ?? 1)
}

// --- data directory --------------------------------------------------------------------------
//
// The kernel creates it too, at first write. Creating it here means a fresh checkout looks
// finished after setup instead of after the first request.

step(3 + pluginSetups.length, 3 + pluginSetups.length, "data directory")
const dataDir = process.env.QWBE_DATA_DIR ?? join(root, "data")
if (existsSync(dataDir)) {
  console.log(`      ${dataDir} — already there`)
} else {
  mkdirSync(dataDir, { recursive: true })
  console.log(`      ${dataDir} — created`)
}

console.log(`\n${bold("Setup done.")} Start everything with:\n\n    npm start\n`)
