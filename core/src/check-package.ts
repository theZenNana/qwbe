// `qwbe check <dir>` -- the one entry point that says whether a package is done (QWB-54
// ticket 03). The kernel runs the same four stages, in the same order, for every package:
//
//   1. source      -- the boot-time package contract, THE SAME CODE the kernel runs at mount
//                     (`checkPackageSource`, no options), so a pack cannot pass here and fail
//                     at boot, or the other way round.
//   2. caps        -- the size caps read from the INSTALLED kernel's qwbe.config.json. A
//                     qwbe.config.json inside the package is an error, not an override: the
//                     numbers belong to the kernel, and a pack that could rewrite them would be
//                     writing its own rules again.
//   3. runtime     -- the kernel is booted in a sandbox with the package mounted, and the
//                     package's own probes/*.mjs run against that kernel. A missing or empty
//                     probes/ is an error: a package that never runs proves nothing.
//   4. invocation  -- how the package asked to be checked. `scripts.test` must be exactly
//                     `qwbe check .`; `dependencies["qwbe-core"]` must not point at a checkout
//                     (`file:`, `link:`, `github:`); and `require.resolve("qwbe-core")` from the
//                     package must land on a real install under its own node_modules -- which
//                     catches `npm link`, whose symlink resolves outside the package.
//
// The library returns data; `bin/qwbe.mjs` prints it. The stages fail fast, all findings of the
// failing stage together, so the first thing a pack author reads is the stage that stopped them.

import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, sep } from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { runGenericStage } from "./check-probes.ts"
import { checkPackageSource } from "./package-contract.ts"
import type { PackageFinding } from "./package-contract-scan.ts"
import { capsFromConfig, type RawConfig, type SizeCaps, sizeCapsFindings } from "./package-size.ts"
import { includePackageSourcePath, isBookkeeping } from "./package-source.ts"

export type { PackageFinding }
export type CheckStage = "source" | "caps" | "runtime" | "invocation"

export type ProbeRun = { readonly probe: string; readonly exit: number | null }
export type RuntimeEvidence = {
  readonly booted: boolean
  readonly url: string
  readonly probes: ReadonlyArray<ProbeRun>
  /** The generic probes (QWB-54, ticket 08): how many assertions ran and how many findings
   *  they raised. Absent when the stage stopped before them. */
  readonly generic?: { readonly checks: number; readonly findings: number }
}

export type CheckReport = {
  readonly ok: boolean
  readonly failedStage?: CheckStage
  readonly findings: ReadonlyArray<PackageFinding>
  readonly runtime?: RuntimeEvidence
}

export type CheckOptions = {
  /**
   * Boot the real kernel for the runtime stage (default). Unit tests pass false: the stage
   * still checks that probes/ exists and is non-empty, but boots nothing.
   */
  readonly boot?: boolean
}

// --- the installed kernel -------------------------------------------------------------------

let kernelRootCache: string | undefined

/**
 * The qwbe-core package this command IS. Walking up from this module, the first package.json
 * named qwbe-core is the kernel whose checker, caps and main.ts a check uses -- inside a
 * checkout that is core/, in a pack it is node_modules/qwbe-core. One spelling, everywhere.
 */
export const kernelRoot = (): string => {
  if (kernelRootCache) return kernelRootCache
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 20; i++) {
    const manifest = join(dir, "package.json")
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }
        if (pkg.name === "qwbe-core") {
          kernelRootCache = dir
          return dir
        }
      } catch {
        /* not readable -- keep walking */
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error("cannot find the qwbe-core package above the running qwbe command")
}

/** The caps of the installed kernel. A config that cannot be parsed or is wrong is a kernel bug. */
export const kernelCaps = (): SizeCaps => {
  const path = join(kernelRoot(), "qwbe.config.json")
  if (!existsSync(path)) {
    throw new TypeError(`the installed kernel has no qwbe.config.json at ${path} -- caps cannot be read`)
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as RawConfig
  return capsFromConfig(raw)
}

/**
 * True when this qwbe-core is an INSTALL (a tarball landing under node_modules) rather than a
 * checkout. An install cannot execute any TypeScript under the package -- node refuses type
 * stripping below node_modules -- so everything an installed check runs must come from dist/.
 */
export const isInstalledKernel = (): boolean => kernelRoot().split(sep).join("/").includes("/node_modules/")

/**
 * The kernel entry the runtime stage boots. A checkout boots src/main.ts -- the same source
 * `npm run api` runs. An install boots dist/main.js, the compiled kernel the tarball carries.
 */
export const kernelMainEntry = (): string =>
  isInstalledKernel() ? join(kernelRoot(), "dist", "main.js") : join(kernelRoot(), "src", "main.ts")

// --- stage 2: caps ---------------------------------------------------------------------------

/** A pack's own qwbe.config.json would be an override. Overrides are the thing this command kills. */
export const capsSourceFindings = (dir: string): PackageFinding[] => {
  if (!existsSync(join(dir, "qwbe.config.json"))) return []
  return [
    {
      rule: "caps-source",
      file: "qwbe.config.json",
      message:
        "a package cannot carry its own caps -- size caps come from the installed kernel's " +
        "qwbe.config.json; delete this file",
    },
  ]
}

const capsFindings = (dir: string, caps: SizeCaps): PackageFinding[] => [
  ...capsSourceFindings(dir),
  ...sizeCapsFindings(dir, caps),
]

// --- stage 3: runtime ------------------------------------------------------------------------

/** The probes a package brings. Missing directory or no *.mjs is an error, not a warning. */
export const probesFindings = (dir: string): { findings: PackageFinding[]; probes: string[] } => {
  const probesDir = join(dir, "probes")
  if (!existsSync(probesDir)) {
    return {
      findings: [
        {
          rule: "probes",
          file: "probes/",
          message: "probes/ is missing -- a package must carry at least one runtime probe (*.mjs)",
        },
      ],
      probes: [],
    }
  }
  const probes = readdirSync(probesDir)
    .filter((f) => f.endsWith(".mjs"))
    .sort()
  if (probes.length === 0) {
    return {
      findings: [
        {
          rule: "probes",
          file: "probes/",
          message: "no *.mjs in probes/ -- an empty probes/ proves nothing at runtime",
        },
      ],
      probes: [],
    }
  }
  return { findings: [], probes }
}

/**
 * The sandbox the runtime stage boots the kernel in: one temp workspace INSIDE the qwbe-core
 * package, so the mounted package's `import "qwbe-core/..."` resolves by the same
 * self-reference rule that makes every installed pack work. The package goes to
 * `plugins/<name>` under the one content rule -- what staging ships
 * (includePackageSourcePath) minus the bookkeeping files (isBookkeeping) -- and its
 * `qwbe-package.json` goes to `store/<name>/` -- the exact shape an install leaves behind.
 * Exported for install-filters.test.ts, which pins the sandbox copy to the same content
 * rule the install copy uses.
 */
export const stageSandbox = (
  dir: string,
  name: string,
  installed: boolean,
): { root: string; plugins: string; store: string; data: string } => {
  // Inside a checkout the sandbox lives under core/, so the mounted pack's `import "qwbe-core/..."`
  // resolves by self-reference to the checkout's own sources. Under an INSTALL that is impossible:
  // everything below the package is node_modules territory, where node refuses to strip types --
  // pack cubes included. The sandbox then moves to the system temp directory and gets a
  // node_modules symlink to the real install, which resolves qwbe-core's compiled dist/ (via the
  // qwbe-dist export condition the spawned kernel carries) and the kernel's own dependencies
  // (effect, pg) for the mounted cubes.
  const root = mkdtempSync(join(installed ? tmpdir() : kernelRoot(), ".qwbe-check-"))
  const plugins = join(root, "plugins")
  const store = join(root, "store")
  const data = join(root, "data")
  mkdirSync(plugins, { recursive: true })
  mkdirSync(join(store, name), { recursive: true })
  mkdirSync(data, { recursive: true })
  // The package mounts as plugins/<name> -- one directory inside the plugins root, exactly the
  // shape discovery scans -- and the manifest lands in the store under the same name.
  cpSync(dir, join(plugins, name), {
    recursive: true,
    // The one content rule: what staging would ship (top-level tooling state out) minus the
    // bookkeeping files. The install copy in kernel/install.ts uses the same two predicates --
    // install-filters.test.ts fails the day the two copies diverge again.
    filter: (src) => includePackageSourcePath(dir, src) && !isBookkeeping(src),
  })
  copyFileSync(join(dir, "qwbe-package.json"), join(store, name, "qwbe-package.json"))
  if (installed) symlinkSync(dirname(kernelRoot()), join(root, "node_modules"))
  return { root, plugins, store, data }
}

/** A throwaway Postgres database for one check run -- the probes' model (probes/lib.mjs). */
const adminUrl = (): string => {
  const u = new URL("postgres://localhost/postgres")
  u.hostname = process.env.QWBE_PG_HOST ?? "localhost"
  u.port = process.env.QWBE_PG_PORT ?? "5433"
  u.username = process.env.QWBE_PG_USER ?? "postgres"
  u.password = process.env.QWBE_PG_PASSWORD ?? "qwbe"
  return u.toString()
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolve(port))
    })
  })

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The runtime stage without the boot: the probes/ shape check alone. Unit tests use it. */
const runtimeStageNoBoot = (dir: string): CheckReport => {
  const { findings } = probesFindings(dir)
  if (findings.length > 0) return { ok: false, failedStage: "runtime", findings }
  return { ok: true, findings: [], runtime: { booted: false, url: "", probes: [] } }
}

/**
 * Boot the installed kernel with exactly one package mounted, run its probes against it, tear
 * everything down. The kernel the probes run against is the same qwbe-core this command is --
 * that is the "same binary" property, and it is why the check cannot be faked from outside.
 */
export const runtimeStage = async (dir: string): Promise<CheckReport> => {
  const { findings: probeFindings, probes } = probesFindings(dir)
  if (probeFindings.length > 0) return { ok: false, failedStage: "runtime", findings: probeFindings }

  const manifest = JSON.parse(readFileSync(join(dir, "qwbe-package.json"), "utf8")) as {
    name?: unknown
    cubes?: unknown
  }
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    return {
      ok: false,
      failedStage: "runtime",
      findings: [{ rule: "manifest", file: "qwbe-package.json", message: "manifest.name must be a non-empty string" }],
    }
  }
  // The cubes the package says it brings -- the generic probes are derived per cube. A
  // malformed list is the source stage's finding to report; here it only means fewer probes.
  const cubes = Array.isArray(manifest.cubes) ? manifest.cubes.filter((c): c is string => typeof c === "string") : []
  const db = `qwbe_check_${randomBytes(4).toString("hex")}`
  const admin = new pg.Pool({ connectionString: adminUrl(), max: 1 })
  let dbUrl = ""
  let proc: ReturnType<typeof spawn> | undefined
  let output = ""
  let sandboxRoot: string | undefined
  const evidence: { booted: boolean; url: string; probes: ProbeRun[]; generic?: { checks: number; findings: number } } =
    {
      booted: false,
      url: "",
      probes: [],
    }
  const installed = isInstalledKernel()
  try {
    const sandbox = stageSandbox(dir, manifest.name, installed)
    sandboxRoot = sandbox.root
    await admin.query(`CREATE DATABASE "${db}"`)
    const u = new URL(adminUrl())
    u.pathname = `/${db}`
    dbUrl = u.toString()
    const port = await freePort()
    // The spawned kernel must resolve the mounted pack's `import "qwbe-core/..."` to the compiled
    // dist/ -- the qwbe-dist condition in the exports map -- because src/*.ts cannot load under
    // node_modules. A checkout spawns without the condition and keeps resolving the sources.
    const nodeArgs = installed ? ["--conditions=qwbe-dist"] : []
    proc = spawn(process.execPath, [...nodeArgs, kernelMainEntry()], {
      env: {
        ...process.env,
        QWBE_PORT: String(port),
        QWBE_ADMIN_PASSWORD: "admin",
        QWBE_READER_PASSWORD: "reader",
        QWBE_DATA_DIR: sandbox.data,
        QWBE_PLUGINS_DIR: sandbox.plugins,
        QWBE_STORE_DIR: sandbox.store,
        QWBE_DATABASE_URL: dbUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    proc.stdout?.on("data", (d: Buffer) => (output += d))
    proc.stderr?.on("data", (d: Buffer) => (output += d))

    // Wait for the kernel the way the probes do: 401 on the spec counts as listening too.
    let up = false
    for (let i = 0; i < 60 && !up; i++) {
      await wait(250)
      if (proc.exitCode !== null) break
      try {
        const r = await fetch(`http://127.0.0.1:${port}/openapi.json`)
        up = r.status === 200 || r.status === 401
      } catch {
        /* not listening yet */
      }
    }
    if (!up) {
      return {
        ok: false,
        failedStage: "runtime",
        findings: [
          {
            rule: "boot",
            file: installed ? "qwbe-core/dist/main.js" : "qwbe-core/src/main.ts",
            message: `the kernel did not start with the package mounted (exit ${proc.exitCode}):\n${output.slice(-4000)}`,
          },
        ],
        runtime: evidence,
      }
    }
    evidence.booted = true
    evidence.url = `http://127.0.0.1:${port}`

    // The generic probes (QWB-54, ticket 08) run FIRST, against the booted kernel, before the
    // package's own probes: they are derived from the package's own declarations, so a pack
    // cannot skip, weaken or pre-empt them. An invented dataMigration never reaches this
    // point at all -- the ownership rules refuse it at boot. The declarations dump reads the
    // MOUNTED copy, not the checked directory: discovery imports cubes from the plugins root,
    // and only there does `import "qwbe-core/..."` resolve the way the booted kernel resolves
    // it (a checkout sandbox sits inside qwbe-core; an install sandbox carries the
    // node_modules link), so the probes judge exactly the code the kernel loaded.
    const generic = await runGenericStage({
      dir: join(sandbox.plugins, manifest.name),
      cubes,
      url: evidence.url,
      adminPassword: "admin",
      conditions: installed ? ["--conditions=qwbe-dist"] : [],
      kernelRoot: kernelRoot(),
    })
    evidence.generic = { checks: generic.checks, findings: generic.findings.length }
    if (generic.findings.length > 0) {
      return { ok: false, failedStage: "runtime", findings: generic.findings, runtime: evidence }
    }

    const failures: PackageFinding[] = []
    for (const probe of probes) {
      // The condition rides along to the probes too: a pack probe that imports qwbe-core/* from
      // an install must reach dist/, exactly like the kernel it is judging.
      const r = spawnSync(
        process.execPath,
        [...(installed ? ["--conditions=qwbe-dist"] : []), join(dir, "probes", probe)],
        {
          cwd: dir,
          env: {
            ...process.env,
            QWBE_URL: evidence.url,
            QWBE_ADMIN_PASSWORD: "admin",
            QWBE_READER_PASSWORD: "reader",
          },
          stdio: "inherit",
          encoding: "utf8",
        },
      )
      evidence.probes.push({ probe, exit: r.status })
      if (r.status !== 0) {
        failures.push({
          rule: "probe",
          file: `probes/${probe}`,
          message: `exit ${r.status ?? "signal"} against the running kernel -- see the probe's output above`,
        })
      }
    }
    if (failures.length > 0) return { ok: false, failedStage: "runtime", findings: failures, runtime: evidence }
    return { ok: true, findings: [], runtime: evidence }
  } finally {
    proc?.kill("SIGTERM")
    await wait(400)
    if (proc?.exitCode === null) proc.kill("SIGKILL")
    if (dbUrl) await admin.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`).catch(() => {})
    await admin.end().catch(() => {})
    if (sandboxRoot) rmSync(sandboxRoot, { recursive: true, force: true })
  }
}

// --- stage 4: invocation ---------------------------------------------------------------------

export type ResolveQwbeCore = (dir: string) => string

/**
 * How the pack resolves qwbe-core, anchored at the pack's own package.json. Exported for the
 * same reason the resolution rule exists: to be proved, not assumed.
 */
export const resolveFromPack: ResolveQwbeCore = (dir: string): string =>
  createRequire(join(dir, "package.json")).resolve("qwbe-core/package.json")

export const invocationFindings = (dir: string, resolve: ResolveQwbeCore = resolveFromPack): PackageFinding[] => {
  const findings: PackageFinding[] = []
  const manifestPath = join(dir, "package.json")
  if (!existsSync(manifestPath)) {
    return [
      { rule: "invocation", file: "package.json", message: "package.json is missing -- a qwbe pack is an npm package" },
    ]
  }
  let pkg: { scripts?: Record<string, unknown>; dependencies?: Record<string, unknown> }
  try {
    pkg = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      scripts?: Record<string, unknown>
      dependencies?: Record<string, unknown>
    }
  } catch (error) {
    return [{ rule: "invocation", file: "package.json", message: `package.json is not valid JSON: ${String(error)}` }]
  }

  if (pkg.scripts?.test !== "qwbe check .") {
    findings.push({
      rule: "invocation-test",
      file: "package.json",
      message:
        `scripts.test must be exactly "qwbe check ." -- found ${JSON.stringify(pkg.scripts?.test ?? null)}. ` +
        `The command, not a private suite, is what "tested" means`,
    })
  }

  const dep = pkg.dependencies?.["qwbe-core"]
  if (typeof dep !== "string") {
    findings.push({
      rule: "invocation-dependency",
      file: "package.json",
      message: `dependencies["qwbe-core"] is missing -- the pack must depend on the kernel it is checked against`,
    })
  } else if (/^(file:|link:|github:)/.test(dep)) {
    findings.push({
      rule: "invocation-dependency",
      file: "package.json",
      message:
        `"qwbe-core": ${JSON.stringify(dep)} names a checkout, not an install -- depend on the ` +
        `tarball from npm pack (a plain version), so every pack runs the same published shape`,
    })
  }

  let resolved: string
  try {
    resolved = resolve(dir)
  } catch {
    findings.push({
      rule: "invocation-install",
      file: "package.json",
      message: "qwbe-core does not resolve from the package -- install it (npm install <tarball>), not npm link",
    })
    return findings
  }
  const real = realpathSync(resolved)
  const realPack = realpathSync(dir)
  const under = `${join(realPack, "node_modules")}/`
  if (!real.startsWith(under)) {
    findings.push({
      rule: "invocation-install",
      file: "package.json",
      message:
        `qwbe-core resolves to ${real}, which is not under the package's own node_modules -- ` +
        `npm link is a checkout, not an install; install the tarball from npm pack`,
    })
  }
  return findings
}

// --- the four stages, in order ---------------------------------------------------------------

/**
 * The whole command. Stages run in order and the first failing stage stops the check; a pass
 * means all four passed against the installed kernel. The report carries the runtime evidence
 * (booted URL, probe exits) so the caller's output can SHOW what ran.
 */
export const checkPackage = async (dir: string, options: CheckOptions = {}): Promise<CheckReport> => {
  const boot = options.boot ?? true

  // 1. Source: the boot gate's own checker, unchanged.
  const sourceFindings = await checkPackageSource(dir)
  if (sourceFindings.length > 0) return { ok: false, failedStage: "source", findings: sourceFindings }

  // 2. Caps: read from the installed kernel; a pack config is refused before anything is measured.
  const caps = kernelCaps()
  const capFindings = capsFindings(dir, caps)
  if (capFindings.length > 0) return { ok: false, failedStage: "caps", findings: capFindings }

  // 3. Runtime: sandbox kernel + the pack's probes. Without `boot` only the probes/ shape is
  // judged -- the same stage, minus the process it starts.
  const runtime = boot ? await runtimeStage(dir) : runtimeStageNoBoot(dir)
  if (!runtime.ok) return runtime

  // 4. Invocation: how the pack asked to be tested.
  const invFindings = invocationFindings(dir)
  if (invFindings.length > 0) {
    return {
      ok: false,
      failedStage: "invocation",
      findings: invFindings,
      runtime: runtime.runtime ?? { booted: false, url: "", probes: [] },
    }
  }

  return { ok: true, findings: [], runtime: runtime.runtime ?? { booted: false, url: "", probes: [] } }
}
