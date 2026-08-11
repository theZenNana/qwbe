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

// --- 3. isolated Python plugin dependencies --------------------------------------------------

step(3, 4, "ActiveGraph plugin environment")
const agentPlugin = join(root, "core/plugins/activegraph-plugin")
const agentVenv = join(root, ".qwb-activegraph-venv")
const python = process.platform === "win32" ? "python" : "python3"
const agentPython = process.platform === "win32" ? join(agentVenv, "Scripts/python.exe") : join(agentVenv, "bin/python")
const pythonVersion = spawnSync(python, ["--version"], { encoding: "utf8" })
if (pythonVersion.status !== 0) {
  console.error("\nThe ActiveGraph plugin needs Python 3.11 or newer. No system package was installed.\n")
  process.exit(1)
}
const pythonParts = parseVersion(`${pythonVersion.stdout}${pythonVersion.stderr}`.replace(/^Python\s+/, "").trim())
if (isOlder(pythonParts, [3, 11, 0])) {
  console.error(`\nThe ActiveGraph plugin needs Python 3.11 or newer -- found ${pythonParts.join(".")}.\n`)
  process.exit(1)
}
if (!existsSync(agentPython)) {
  const made = spawnSync(python, ["-m", "venv", agentVenv], { stdio: "inherit" })
  if (made.status !== 0) process.exit(made.status ?? 1)
}
const installed = spawnSync(agentPython, ["-m", "pip", "install", "-r", join(agentPlugin, "requirements.lock")], {
  stdio: "inherit",
})
if (installed.status !== 0) process.exit(installed.status ?? 1)

// --- 3. data directory -----------------------------------------------------------------------
//
// The kernel creates it too, at first write. Creating it here means a fresh checkout looks
// finished after setup instead of after the first request.

step(4, 4, "data directory")
const dataDir = process.env.QWBE_DATA_DIR ?? join(root, "data")
if (existsSync(dataDir)) {
  console.log(`      ${dataDir} — already there`)
} else {
  mkdirSync(dataDir, { recursive: true })
  console.log(`      ${dataDir} — created`)
}

console.log(`\n${bold("Setup done.")} Start everything with:\n\n    npm start\n`)
