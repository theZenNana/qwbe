#!/usr/bin/env node
// The `qwbe` binary, delivered by qwbe-core. A pack installs the kernel
// from the tarball `npm pack` produces, and `node_modules/.bin/qwbe` is how its npm scripts
// reach the command: `scripts.test` is `qwbe check .`, and that must be the WHOLE test story --
// the pack does not get to choose its own gates.
//
// This file is a thin argv layer; every rule lives in core/src/check-package.ts, where it is
// unit-tested. Prints a stage report and exits 0 (pass) or 1 (a stage failed); 2 is a usage
// or environment error, not a verdict about the package.
//
// Where the checker loads from: node refuses to strip types for any file under node_modules, so
// an installed kernel (bin/qwbe.mjs inside node_modules/qwbe-core) imports the compiled
// dist/check-package.js that prepack built into the tarball. A checkout runs the very TypeScript
// source the kernel boots -- one checker, no second implementation to drift.
const installed = import.meta.url.includes("/node_modules/")
const { checkPackage } = await import(installed ? "../dist/check-package.js" : "../src/check-package.ts")

const argv = process.argv.slice(2)
const usage = `usage: qwbe check <package-dir>
       qwbe drift [store-dir]

check runs the four stages every qwbe package is judged by:
  1. source     the boot-time package contract (the kernel's own checker)
  2. caps       size caps from the installed kernel's qwbe.config.json
  3. runtime    the kernel booted with the package mounted, plus the package's probes/*.mjs
  4. invocation scripts.test is "qwbe check .", the qwbe-core dependency is an install
`

const command = argv[0]
const dirArg = argv[1]

if (command === "drift") {
  // Is every shelf in the store provably what its source holds? Default
  // store: the one next to this bin. Exit 0 every shelf verified; 1 is the red the ticket asks
  // for - drifted, edited or untraceable shelves; 2 a usage or environment error.
  if (argv.length > 2) {
    console.error(usage)
    process.exit(2)
  }
  const { storeDrift } = await import(installed ? "../dist/store-drift.js" : "../src/store-drift.ts")
  const { existsSync } = await import("node:fs")
  const { resolve } = await import("node:path")
  const storeDir = dirArg === undefined ? resolve(import.meta.dirname, "..", "store") : resolve(dirArg)
  if (!existsSync(storeDir)) {
    console.error(`qwbe drift: no store directory at ${storeDir}`)
    process.exit(2)
  }
  const verdicts = storeDrift(storeDir)
  const red = verdicts.filter((v) => v.status !== "ok")
  for (const v of verdicts) {
    if (v.status === "ok") console.log(`  ok        ${v.name}  staged ${v.stagedAt} from ${v.sourcePath}`)
    else if (v.status === "no-provenance") console.log(`  RED       ${v.name}  ${v.detail}`)
    else console.log(`  RED       ${v.name}  staged ${v.stagedAt} from ${v.sourcePath} -- ${v.detail}`)
  }
  console.log(
    red.length === 0
      ? `  qwbe drift: PASS (${verdicts.length} shelves)`
      : `  qwbe drift: FAIL (${red.length} of ${verdicts.length} shelves are behind, edited or untraceable)`,
  )
  process.exit(red.length === 0 ? 0 : 1)
}

if (command !== "check" || argv.length !== 2) {
  console.error(usage)
  process.exit(2)
}

const dir = dirArg === "." ? process.cwd() : dirArg

const render = (report) => {
  const lines = []
  if (report.ok) {
    lines.push(`  [1/4] source: ok`)
    lines.push(`  [2/4] caps: ok`)
    const r = report.runtime
    lines.push(
      `  [3/4] runtime: kernel booted at ${r.url}; ` +
        (r.generic ? `generic probes: ${r.generic.checks} checks, ${r.generic.findings} findings; ` : ``) +
        `probes: ` +
        r.probes.map((p) => `${p.probe} exit ${p.exit}`).join(", "),
    )
    lines.push(`  [4/4] invocation: ok`)
    lines.push(`  qwbe check: PASS`)
  } else {
    lines.push(`  qwbe check: FAIL (stage ${report.failedStage})`)
    for (const f of report.findings) lines.push(`    ${f.rule}: ${f.file} -- ${f.message}`)
  }
  return lines.join("\n")
}

try {
  const report = await checkPackage(dir)
  console.log(render(report))
  process.exit(report.ok ? 0 : 1)
} catch (error) {
  // A malformed kernel config or an unreadable installation is an environment error, not a
  // verdict about the package.
  console.error(`qwbe check could not run: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}
