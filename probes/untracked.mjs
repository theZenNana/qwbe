#!/usr/bin/env node
// Cubes that RUN but are not in git.
//
// Found on 2 Aug 2026 by the coordinator, not by any gate: `core/src/cubes/tasks/`,
// `core/src/spaces/erp/`, `core/store/erp-pack/`, `core/store/customfields-pack/`,
// `core/plugins/crm-pack/` were all untracked — and all mounted. The catalogue listed them,
// `/tasks` answered 200. Working code that no commit contains.
//
// That is the worst shape a repository can be in, worse than a red test:
//
//   - `git clone` gives you a DIFFERENT system than the one running here;
//   - `git checkout` on another branch can silently delete a live cube;
//   - a review of `git log` shows nothing, so nobody knows the code exists;
//   - and the thing works, so nothing ever complains.
//
// Discovery is by directory, which is what makes qwbe pleasant AND what makes this possible:
// dropping a folder in is enough to mount a cube, and git never hears about it. So the gate
// reads the same two sources and compares them — what is on disk against what is committed.
//
//   node probes/untracked.mjs           list them, exit 1 if any
//   node probes/untracked.mjs --json

import { execFileSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const json = process.argv.includes("--json")

/** Where a directory becomes a mounted thing rather than just a folder. */
const MOUNT_POINTS = [
  { dir: join(root, "core", "src", "cubes"), kind: "cub de sistem" },
  { dir: join(root, "core", "src", "spaces"), kind: "spațiu" },
  { dir: join(root, "core", "plugins"), kind: "plugin" },
  { dir: join(root, "core", "store"), kind: "pachet din store" },
]

const subdirectories = (dir) => {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
    .map((d) => d.name)
    .sort()
}

// `--others --exclude-standard` is what git itself calls untracked: on disk, not in the index,
// not ignored. Asking git rather than guessing means .gitignore is honoured for free.
const untrackedFiles = () => {
  try {
    const out = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
    })
    return out.split("\n").filter(Boolean)
  } catch (error) {
    console.error(`nu s-a putut interoga git: ${error.message}`)
    process.exit(2)
  }
}

const files = untrackedFiles()

const findings = []
for (const point of MOUNT_POINTS) {
  for (const name of subdirectories(point.dir)) {
    const unitPath = `${relative(root, join(point.dir, name))}/`.replaceAll("\\", "/")
    const own = files.filter((f) => f.startsWith(unitPath))
    if (own.length === 0) continue
    // A unit is "untracked" only if git knows NONE of it. A tracked cube with one new file is a
    // normal work in progress, not a ghost — flagging it would make the gate noise.
    const tracked = execFileSync("git", ["ls-files", unitPath], { cwd: root, encoding: "utf8" }).trim()
    if (tracked.length > 0) continue
    findings.push({ kind: point.kind, name, path: unitPath, files: own.length })
  }
}

if (json) {
  console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2))
  process.exit(findings.length === 0 ? 0 : 1)
}

console.log(`\nCod viu care nu e în git — ${findings.length} ${findings.length === 1 ? "unitate" : "unități"}\n`)

if (findings.length === 0) {
  console.log("  Tot ce se montează e comis.\n")
  process.exit(0)
}

for (const f of findings) {
  const count = f.files === 1 ? "1 fișier" : `${f.files} fișiere`
  console.log(`  ✗ ${f.kind} ${f.name} — ${count}, niciunul în git (${f.path})`)
}

console.log(
  `\nAstea se montează la pornire și răspund la cereri, dar niciun commit nu le conține.\n` +
    `Un 'git clone' dă alt sistem decât cel care rulează aici, iar un 'git checkout' le poate\n` +
    `șterge fără ca cineva să observe. Se comit sau se șterg — a treia variantă nu există.\n`,
)
process.exit(1)
