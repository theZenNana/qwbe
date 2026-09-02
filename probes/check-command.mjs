// Runtime proof for `qwbe check` (QWB-54 ticket 03): the real bin, run as a real process,
// against real fixture packages in a temp directory. The unit tests prove the rules; this probe
// proves the COMMAND -- the sandbox kernel boot, the probes running against it, and the exit
// codes a pack's `npm test` will see.
//
// Each fixture package gets an "installed" qwbe-core under its node_modules, built the way the
// tarball from `npm pack` would land: a real directory (bin/, src/, qwbe.config.json,
// package.json), never a symlink -- except the one fixture that simulates `npm link`, which is
// exactly the case the invocation stage must refuse.
//
//   node probes/check-command.mjs

import { spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const core = join(root, "core")
const BIN = join(core, "bin", "qwbe.mjs")

const results = []
const check = (name, ok, detail = "") => {
  results.push({ name, ok })
  console.log(`  ${ok ? "ok" : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`)
}

const base = mkdtempSync(join(tmpdir(), "qwbe-check-probe-"))
const cleanup = () => rmSync(base, { recursive: true, force: true })
process.on("exit", cleanup)
try {
  process.on("SIGINT", () => process.exit(130))

  // The kernel as a pack would install it from the tarball `npm pack` produces: real directory,
  // the files field's contents (bin, src, dist, qwbe.config.json), node_modules reaching the real
  // one. dist/ is what an installed bin and kernel actually execute -- node refuses TypeScript
  // under node_modules -- and prepack builds it into the tarball; the simulation copies it when
  // a build is present, so this probe also runs from a checkout nobody has compiled yet.
  const installKernel = (fixture) => {
    const dest = join(fixture, "node_modules", "qwbe-core")
    mkdirSync(dirname(dest), { recursive: true })
    for (const entry of ["bin", "src", "package.json", "qwbe.config.json"]) {
      cpSync(join(core, entry), join(dest, entry), { recursive: true, filter: (s) => !s.includes("node_modules") })
    }
    if (existsSync(join(core, "dist"))) {
      cpSync(join(core, "dist"), join(dest, "dist"), { recursive: true, filter: (s) => !s.includes("node_modules") })
    }
    symlinkSync(join(core, "node_modules"), join(dest, "node_modules"))
    return dest
  }

  // The fixture package: one real cube, the required invocation, one probe that talks to the
  // booted kernel over QWBE_URL -- the contract a pack's probes are written against.
  const CUBE = `import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization } from "qwbe-core/auth"
import { type CubeTools, defineCube } from "qwbe-core/cube"
import { Forbidden } from "qwbe-core/errors"

const group = HttpApiGroup.make("gadgets")
  .add(HttpApiEndpoint.get("list")\`/gadgets\`.addSuccess(Schema.Array(Schema.String)).addError(Forbidden))
  .middleware(Authorization)

export const cube = defineCube(group, {
  manifest: { name: "gadgets", tables: [], requiresAuth: true, permissions: [{ name: "gadgets:read", roles: ["admin"] }] },
  create: (_tools: CubeTools) => ({ handlers: { list: () => Effect.succeed(["wrench"]) } }),
})
`
  const PROBE = `// Runs against the kernel qwbe check booted; QWBE_URL is the contract.
const base = process.env.QWBE_URL
if (!base) {
  console.error("refused: QWBE_URL is not set -- run me through qwbe check")
  process.exit(1)
}
const spec = await fetch(base + "/openapi.json")
const r = await fetch(base + "/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: process.env.QWBE_ADMIN_PASSWORD ?? "admin" }),
})
const body = await r.json()
if (!r.ok || !body.token) {
  console.error("refused: login against the checked kernel failed")
  process.exit(1)
}
const cubes = await fetch(base + "/settings/cubes", { headers: { authorization: "Bearer " + body.token } })
const names = JSON.parse(await cubes.text()).map((c) => c.name)
console.log("probe saw the kernel at", base, "with cubes:", names.join(", "))
if (!names.includes("gadgets")) {
  console.error("refused: the checked package's cube is not mounted")
  process.exit(1)
}
if (spec.status !== 200 && spec.status !== 401) {
  console.error("refused: the kernel does not answer")
  process.exit(1)
}
`
  const makeFixture = (name, mutate) => {
    const fixture = join(base, name)
    mkdirSync(join(fixture, "cubes", "gadgets"), { recursive: true })
    mkdirSync(join(fixture, "probes"), { recursive: true })
    writeFileSync(join(fixture, "qwbe-package.json"), JSON.stringify({ name, kind: "plugin", cubes: ["gadgets"] }))
    writeFileSync(join(fixture, "cubes", "gadgets", "index.ts"), CUBE)
    writeFileSync(join(fixture, "probes", "selfcheck.mjs"), PROBE)
    writeFileSync(
      join(fixture, "package.json"),
      JSON.stringify({
        name,
        private: true,
        type: "module",
        scripts: { test: "qwbe check ." },
        dependencies: { "qwbe-core": "0.0.0" },
      }),
    )
    if (mutate) mutate(fixture)
    return fixture
  }

  const runCheck = (fixture) =>
    spawnSync(process.execPath, [BIN, "check", fixture], { encoding: "utf8", timeout: 120000 })

  // --- the passing package: all four stages green, against the installed kernel -------------------
  const good = makeFixture("good-pack")
  installKernel(good)
  const pass = runCheck(good)
  check(
    "a clean package passes all four stages (exit 0)",
    pass.status === 0 && pass.stdout.includes("qwbe check: PASS"),
    `exit ${pass.status}`,
  )
  check(
    "the output shows the stages in order, with the runtime evidence",
    /\[1\/4\] source: ok/.test(pass.stdout) &&
      /\[2\/4\] caps: ok/.test(pass.stdout) &&
      // The generic probes (QWB-54, ticket 08) ride the same line: N checks, M findings.
      /\[3\/4\] runtime: kernel booted at http:\/\/127\.0\.0\.1:\d+; generic probes: \d+ checks, \d+ findings; probes: selfcheck\.mjs exit 0/.test(
        pass.stdout,
      ) &&
      /\[4\/4\] invocation: ok/.test(pass.stdout),
  )

  // --- stage 1: a cube importing node:fs is refused before anything boots -------------------------
  const badSource = makeFixture("bad-source-pack", (f) =>
    writeFileSync(
      join(f, "cubes", "gadgets", "lib.ts"),
      `import { readFileSync } from "node:fs"\nexport const r = readFileSync\n`,
    ),
  )
  installKernel(badSource)
  const s1 = runCheck(badSource)
  check(
    "a node:fs import in a cube fails stage source (exit 1), no boot",
    s1.status === 1 && s1.stdout.includes("FAIL (stage source)") && s1.stdout.includes("cube-builtins"),
    `exit ${s1.status}`,
  )
  check("the refused boot left no sandbox behind", !readdirSync(core).some((e) => e.startsWith(".qwbe-check-")))

  // --- stage 2: a pack-side caps file is an error, not an override ---------------------------------
  const badCaps = makeFixture("bad-caps-pack", (f) =>
    writeFileSync(join(f, "qwbe.config.json"), JSON.stringify({ caps: {} })),
  )
  installKernel(badCaps)
  const s2 = runCheck(badCaps)
  check(
    "a qwbe.config.json in the package fails stage caps with the reason",
    s2.status === 1 && s2.stdout.includes("FAIL (stage caps)") && s2.stdout.includes("caps-source"),
    `exit ${s2.status}`,
  )

  // --- stage 3: an empty probes/ is an error, not a warning ----------------------------------------
  const noProbes = makeFixture("no-probes-pack", (f) => rmSync(join(f, "probes", "selfcheck.mjs")))
  installKernel(noProbes)
  const s3 = runCheck(noProbes)
  check(
    "an empty probes/ fails stage runtime",
    s3.status === 1 && s3.stdout.includes("FAIL (stage runtime)") && s3.stdout.includes("no *.mjs in probes/"),
    `exit ${s3.status}`,
  )

  // --- stage 4: the invocation rules, each with its reason ----------------------------------------
  const badTest = makeFixture("bad-test-pack", (f) => {
    const pkg = JSON.parse(readFileSync(join(f, "package.json"), "utf8"))
    pkg.scripts.test = "node --test test/*.mjs"
    writeFileSync(join(f, "package.json"), JSON.stringify(pkg))
  })
  installKernel(badTest)
  const s4 = runCheck(badTest)
  check(
    'a scripts.test other than "qwbe check ." fails stage invocation',
    s4.status === 1 && s4.stdout.includes("FAIL (stage invocation)") && s4.stdout.includes("invocation-test"),
    `exit ${s4.status}`,
  )

  const badDep = makeFixture("bad-dep-pack", (f) => {
    const pkg = JSON.parse(readFileSync(join(f, "package.json"), "utf8"))
    pkg.dependencies["qwbe-core"] = "file:../qwbe/core"
    writeFileSync(join(f, "package.json"), JSON.stringify(pkg))
  })
  installKernel(badDep)
  const s5 = runCheck(badDep)
  check(
    'a "file:" dependency is refused with the reason, at stage invocation',
    s5.status === 1 &&
      s5.stdout.includes("invocation-dependency") &&
      s5.stdout.includes("names a checkout, not an install"),
    `exit ${s5.status}`,
  )

  // npm link: node_modules/qwbe-core is a SYMLINK to the checkout -- the realpath rule catches it.
  const linked = makeFixture("linked-pack")
  rmSync(join(linked, "node_modules", "qwbe-core"), { recursive: true, force: true })
  mkdirSync(join(linked, "node_modules"), { recursive: true })
  symlinkSync(core, join(linked, "node_modules", "qwbe-core"))
  const s6 = runCheck(linked)
  check(
    "npm link is caught: the symlinked qwbe-core resolves outside node_modules",
    s6.status === 1 &&
      s6.stdout.includes("invocation-install") &&
      s6.stdout.includes("not under the package's own node_modules"),
    `exit ${s6.status}`,
  )

  // --- a probe that fails turns the check red, with the probe named --------------------------------
  const failingProbe = makeFixture("failing-probe-pack", (f) =>
    writeFileSync(join(f, "probes", "selfcheck.mjs"), "console.log('this probe fails')\nprocess.exit(1)\n"),
  )
  installKernel(failingProbe)
  const s7 = runCheck(failingProbe)
  check(
    "a failing probe fails stage runtime, naming the probe",
    s7.status === 1 && s7.stdout.includes("FAIL (stage runtime)") && s7.stdout.includes("probes/selfcheck.mjs"),
    `exit ${s7.status}`,
  )
} finally {
  cleanup()
}

const failed = results.filter((r) => !r.ok).length
console.log(`\nqwbe check probe -- ${results.length - failed} pass, ${failed} fail\n`)
process.exit(failed === 0 ? 0 : 1)
