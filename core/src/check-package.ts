// `qwbe check <dir>` -- the one entry point that says whether a package is done. The four
// stages are listed in the usage of qwbe-cli.ts.

import { createRequire } from "node:module"
import { dirname, join, sep } from "node:path"
import { Command, FileSystem } from "@effect/platform"
import { Data, Effect, Either, Option, ParseResult, Schema } from "effect"
import { runGenericStage } from "./check-probes.ts"
import { copyTree } from "./files.ts"
import { freePort } from "./free-port.ts"
import { checkPackageSource } from "./package-contract.ts"
import type { PackageFinding } from "./package-contract-scan.ts"
import { capsFromConfig, type SizeCaps, sizeCapsFindings } from "./package-size.ts"
import { includePackageSourcePath, isBookkeeping, MANIFEST, PackageManifest } from "./package-source.ts"
import { testDatabase } from "./pg/test-db.ts"
import { collectOutput, startScoped, waitReady } from "./server-process.ts"

export type { PackageFinding }

type CheckStage = "source" | "caps" | "runtime" | "invocation"

type ProbeRun = { readonly probe: string; readonly exit: number | null }
type RuntimeEvidence = {
  readonly booted: boolean
  readonly url: string
  readonly probes: ReadonlyArray<ProbeRun>
  /** The generic probes: how many assertions ran and how many findings
   *  they raised. Absent when the stage stopped before them. */
  readonly generic?: { readonly checks: number; readonly findings: number }
}

export type CheckReport = {
  readonly ok: boolean
  readonly failedStage?: CheckStage
  readonly findings: ReadonlyArray<PackageFinding>
  readonly runtime?: RuntimeEvidence
}

/** The command could not judge the package: a broken installation, not a verdict. */
export class CheckCannotRun extends Data.TaggedError("CheckCannotRun")<{ readonly message: string }> {}

// --- the installed kernel -------------------------------------------------------------------

const KernelManifest = Schema.parseJson(Schema.Struct({ name: Schema.Literal("qwbe-core") }))

const isKernelDir = (fs: FileSystem.FileSystem, dir: string) =>
  fs.readFileString(join(dir, "package.json")).pipe(
    Effect.map((text) => Option.isSome(Schema.decodeUnknownOption(KernelManifest)(text))),
    Effect.orElseSucceed(() => false),
  )

/**
 * The qwbe-core package this command IS. Walking up from this module, the first package.json
 * named qwbe-core is the kernel whose checker, caps and main.ts a check uses -- inside a
 * checkout that is core/, in a pack it is node_modules/qwbe-core. One spelling, everywhere.
 */
export const kernelRoot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  for (let dir = import.meta.dirname; ; dir = dirname(dir)) {
    if (yield* isKernelDir(fs, dir)) return dir
    if (dirname(dir) === dir) {
      return yield* new CheckCannotRun({ message: "cannot find the qwbe-core package above the running qwbe command" })
    }
  }
})

const KernelConfig = Schema.parseJson()

/** The caps of the installed kernel. A config that cannot be parsed or is wrong is a kernel bug. */
const kernelCaps = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = join(root, "qwbe.config.json")
    const text = yield* fs.readFileString(path).pipe(
      Effect.mapError(
        () =>
          new CheckCannotRun({
            message: `the installed kernel has no qwbe.config.json at ${path} -- caps cannot be read`,
          }),
      ),
    )
    return yield* capsFromConfig(yield* Schema.decodeUnknown(KernelConfig)(text))
  })

/**
 * True when this qwbe-core is an INSTALL (a tarball landing under node_modules) rather than a
 * checkout. An install cannot execute any TypeScript under the package -- node refuses type
 * stripping below node_modules -- so everything an installed check runs must come from dist/.
 */
const isInstalledKernel = (root: string): boolean => root.split(sep).join("/").includes("/node_modules/")

/**
 * A kernel module the check runs as a process. A checkout runs src/<name>.ts -- the same source
 * `npm run api` runs. An install runs dist/<name>.js, compiled into the tarball.
 */
const kernelEntry = (root: string, name: string): string =>
  isInstalledKernel(root) ? join(root, "dist", `${name}.js`) : join(root, "src", `${name}.ts`)

// --- stage 2: caps ---------------------------------------------------------------------------

/** A pack's own qwbe.config.json would be an override. Overrides are the thing this command kills. */
export const capsSourceFindings = (dir: string) =>
  Effect.map(
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(join(dir, "qwbe.config.json"))),
    (exists): PackageFinding[] =>
      exists
        ? [
            {
              rule: "caps-source",
              file: "qwbe.config.json",
              message:
                "a package cannot carry its own caps -- size caps come from the installed kernel's " +
                "qwbe.config.json; delete this file",
            },
          ]
        : [],
  )

const capsFindings = (dir: string, caps: SizeCaps) =>
  Effect.map(Effect.all([capsSourceFindings(dir), sizeCapsFindings(dir, caps)]), ([own, sizes]) => [...own, ...sizes])

// --- stage 3: runtime ------------------------------------------------------------------------

/** The probes a package brings. Missing directory or no *.mjs is an error, not a warning. */
export const probesFindings = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const probesDir = join(dir, "probes")
    if (!(yield* fs.exists(probesDir))) {
      const findings: PackageFinding[] = [
        {
          rule: "probes",
          file: "probes/",
          message: "probes/ is missing -- a package must carry at least one runtime probe (*.mjs)",
        },
      ]
      return { findings, probes: [] }
    }
    const probes = (yield* fs.readDirectory(probesDir)).filter((f) => f.endsWith(".mjs")).sort()
    if (probes.length === 0) {
      const findings: PackageFinding[] = [
        {
          rule: "probes",
          file: "probes/",
          message: "no *.mjs in probes/ -- an empty probes/ proves nothing at runtime",
        },
      ]
      return { findings, probes }
    }
    return { findings: [] as PackageFinding[], probes }
  })

/**
 * The sandbox the runtime stage boots the kernel in: one temp workspace INSIDE the qwbe-core
 * package, so the mounted package's `import "qwbe-core/..."` resolves by the same
 * self-reference rule that makes every installed pack work. The package goes to
 * `plugins/<name>` under the one content rule -- what staging ships
 * (includePackageSourcePath) minus the bookkeeping files (isBookkeeping) -- and its
 * `qwbe-package.json` goes to `store/<name>/` -- the exact shape an install leaves behind.
 * Removed when the scope closes. Exported for install-filters.test.ts, which pins the sandbox
 * copy to the same content rule the install copy uses.
 */
export const stageSandbox = (dir: string, name: string, root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const installed = isInstalledKernel(root)
    // Inside a checkout the sandbox lives under core/, so the mounted pack's `import "qwbe-core/..."`
    // resolves by self-reference to the checkout's own sources. Under an INSTALL that is impossible:
    // everything below the package is node_modules territory, where node refuses to strip types --
    // pack cubes included. The sandbox then moves to the system temp directory and gets a
    // node_modules symlink to the real install, which resolves qwbe-core's compiled dist/ (via the
    // qwbe-dist export condition the spawned kernel carries) and the kernel's own dependencies
    // (effect, pg) for the mounted cubes.
    const sandbox = yield* fs.makeTempDirectoryScoped({
      prefix: ".qwbe-check-",
      ...(installed ? {} : { directory: root }),
    })
    const plugins = join(sandbox, "plugins")
    const store = join(sandbox, "store")
    const data = join(sandbox, "data")
    yield* fs.makeDirectory(join(store, name), { recursive: true })
    yield* fs.makeDirectory(data, { recursive: true })
    // The package mounts as plugins/<name> -- one directory inside the plugins root, exactly the
    // shape discovery scans -- and the manifest lands in the store under the same name. The one
    // content rule: what staging would ship (top-level tooling state out) minus the bookkeeping
    // files. The install copy in kernel/install.ts uses the same two predicates --
    // install-filters.test.ts fails the day the two copies diverge again.
    yield* copyTree(dir, join(plugins, name), (src) => includePackageSourcePath(dir, src) && !isBookkeeping(src))
    yield* fs.copyFile(join(dir, MANIFEST), join(store, name, MANIFEST))
    if (installed) yield* fs.symlink(dirname(root), join(sandbox, "node_modules"))
    return { root: sandbox, plugins, store, data }
  })

const runtimeFailure = (findings: PackageFinding[], runtime?: RuntimeEvidence): CheckReport => ({
  ok: false,
  failedStage: "runtime",
  findings,
  ...(runtime ? { runtime } : {}),
})

/** One probe against the running kernel, its output straight to this terminal; null = no exit status. */
const runProbe = (dir: string, probe: string, conditions: ReadonlyArray<string>, url: string) =>
  Command.make(process.execPath, ...conditions, join(dir, "probes", probe)).pipe(
    Command.workingDirectory(dir),
    Command.env({ QWBE_URL: url, QWBE_ADMIN_PASSWORD: "admin", QWBE_READER_PASSWORD: "reader" }),
    Command.stdin("inherit"),
    Command.stdout("inherit"),
    Command.stderr("inherit"),
    Command.exitCode,
    Effect.map((code): number | null => code),
    Effect.orElseSucceed(() => null),
  )

const ManifestJson = Schema.parseJson(PackageManifest)

/**
 * Boot the installed kernel with exactly one package mounted, run its probes against it, tear
 * everything down. The kernel the probes run against is the same qwbe-core this command is --
 * that is the "same binary" property, and it is why the check cannot be faked from outside.
 * One scope owns the sandbox directory, the database and the kernel process; closing it stops
 * the process, drops the database and removes the directory, in that order.
 */
const runtimeStage = (dir: string, root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { findings: probeFindings, probes } = yield* probesFindings(dir)
    if (probeFindings.length > 0) return runtimeFailure(probeFindings)

    const manifest = Schema.decodeUnknownOption(ManifestJson)(yield* fs.readFileString(join(dir, MANIFEST)))
    if (Option.isNone(manifest)) {
      return runtimeFailure([
        { rule: "manifest", file: "qwbe-package.json", message: "manifest.name must be a non-empty string" },
      ])
    }
    const { name, cubes = [] } = manifest.value
    const installed = isInstalledKernel(root)
    // The spawned kernel must resolve the mounted pack's `import "qwbe-core/..."` to the compiled
    // dist/ -- the qwbe-dist condition in the exports map -- because src/*.ts cannot load under
    // node_modules. A checkout spawns without the condition and keeps resolving the sources.
    const conditions = installed ? ["--conditions=qwbe-dist"] : []
    const sandbox = yield* stageSandbox(dir, name, root)
    const databaseUrl = yield* testDatabase("check")
    const port = yield* freePort
    const url = `http://127.0.0.1:${port}`
    const proc = yield* startScoped(
      Command.make(process.execPath, ...conditions, kernelEntry(root, "main")).pipe(
        Command.env({
          QWBE_PORT: String(port),
          QWBE_ADMIN_PASSWORD: "admin",
          QWBE_READER_PASSWORD: "reader",
          QWBE_DATA_DIR: sandbox.data,
          QWBE_PLUGINS_DIR: sandbox.plugins,
          QWBE_STORE_DIR: sandbox.store,
          QWBE_DATABASE_URL: databaseUrl,
        }),
      ),
    )

    // Wait for the kernel the way the probes do: 401 on the spec counts as listening too.
    const ready = yield* Effect.either(waitReady(url, proc, yield* collectOutput(proc), "15 seconds"))
    if (Either.isLeft(ready)) {
      const { exit, output } = ready.left
      return runtimeFailure(
        [
          {
            rule: "boot",
            file: installed ? "qwbe-core/dist/main.js" : "qwbe-core/src/main.ts",
            message: `the kernel did not start with the package mounted (exit ${exit}):\n${output.slice(-4000)}`,
          },
        ],
        { booted: false, url: "", probes: [] },
      )
    }

    // The generic probes run FIRST, against the booted kernel, before the
    // package's own probes: they are derived from the package's own declarations, so a pack
    // cannot skip, weaken or pre-empt them. An invented dataMigration never reaches this
    // point at all -- the ownership rules refuse it at boot. The declarations dump reads the
    // MOUNTED copy, not the checked directory: discovery imports cubes from the plugins root,
    // and only there does `import "qwbe-core/..."` resolve the way the booted kernel resolves
    // it (a checkout sandbox sits inside qwbe-core; an install sandbox carries the
    // node_modules link), so the probes judge exactly the code the kernel loaded.
    const generic = yield* runGenericStage({
      dir: join(sandbox.plugins, name),
      cubes,
      url,
      adminPassword: "admin",
      conditions,
      dumpScript: kernelEntry(root, "check-manifests"),
    })
    const evidence = { booted: true, url, generic: { checks: generic.checks, findings: generic.findings.length } }
    if (generic.findings.length > 0) return runtimeFailure(generic.findings, { ...evidence, probes: [] })

    // The condition rides along to the probes too: a pack probe that imports qwbe-core/* from
    // an install must reach dist/, exactly like the kernel it is judging.
    const runs: ProbeRun[] = []
    const failures: PackageFinding[] = []
    for (const probe of probes) {
      const exit = yield* runProbe(dir, probe, conditions, url)
      runs.push({ probe, exit })
      if (exit !== 0) {
        failures.push({
          rule: "probe",
          file: `probes/${probe}`,
          message: `exit ${exit ?? "signal"} against the running kernel -- see the probe's output above`,
        })
      }
    }
    const runtime = { ...evidence, probes: runs }
    return failures.length > 0 ? runtimeFailure(failures, runtime) : { ok: true, findings: [], runtime }
  }).pipe(Effect.scoped)

// --- stage 4: invocation ---------------------------------------------------------------------

// How the pack resolves qwbe-core, anchored at the pack's own package.json (node resolution from
// there): proved by the tests, not assumed. createRequire stays (audit section 4): it is node's
// own resolution, the one a pack's `import` goes through.
const resolveFromPack = (dir: string): string =>
  createRequire(join(dir, "package.json")).resolve("qwbe-core/package.json")

/** The parts of the pack's package.json the invocation rules read. */
const PackJson = Schema.parseJson(
  Schema.Struct({
    scripts: Schema.optional(Schema.Struct({ test: Schema.optional(Schema.Unknown) })),
    dependencies: Schema.optional(Schema.Struct({ "qwbe-core": Schema.optional(Schema.Unknown) })),
  }),
)

const issues = (error: ParseResult.ParseError): string =>
  ParseResult.ArrayFormatter.formatErrorSync(error)
    .map(({ path, message }) => (path.length > 0 ? `${path.join(".")}: ${message}` : message))
    .join("; ")

export const invocationFindings = (dir: string, resolve: (dir: string) => string = resolveFromPack) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const manifestPath = join(dir, "package.json")
    if (!(yield* fs.exists(manifestPath))) {
      const missing: PackageFinding[] = [
        {
          rule: "invocation",
          file: "package.json",
          message: "package.json is missing -- a qwbe pack is an npm package",
        },
      ]
      return missing
    }
    const decoded = Schema.decodeUnknownEither(PackJson)(yield* fs.readFileString(manifestPath))
    if (Either.isLeft(decoded)) {
      const invalid: PackageFinding[] = [
        {
          rule: "invocation",
          file: "package.json",
          message: `package.json is not valid JSON: ${issues(decoded.left)}`,
        },
      ]
      return invalid
    }
    const pkg = decoded.right
    const findings: PackageFinding[] = []

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

    const resolved = yield* Effect.option(Effect.try(() => resolve(dir)))
    if (Option.isNone(resolved)) {
      findings.push({
        rule: "invocation-install",
        file: "package.json",
        message: "qwbe-core does not resolve from the package -- install it (npm install <tarball>), not npm link",
      })
      return findings
    }
    const real = yield* fs.realPath(resolved.value)
    const under = `${join(yield* fs.realPath(dir), "node_modules")}/`
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
  })

// --- the four stages, in order ---------------------------------------------------------------

/**
 * The whole command. Stages run in order and the first failing stage stops the check; a pass
 * means all four passed against the installed kernel. The report carries the runtime evidence
 * (booted URL, probe exits) so the caller's output can SHOW what ran.
 */
export const checkPackage = (dir: string) =>
  Effect.gen(function* () {
    // 1. Source: the boot gate's own checker, unchanged.
    const sourceFindings = yield* Effect.promise(() => checkPackageSource(dir))
    if (sourceFindings.length > 0) {
      const report: CheckReport = { ok: false, failedStage: "source", findings: sourceFindings }
      return report
    }

    // 2. Caps: read from the installed kernel; a pack config is refused before anything is measured.
    const root = yield* kernelRoot
    const capFindings = yield* capsFindings(dir, yield* kernelCaps(root))
    if (capFindings.length > 0) {
      const report: CheckReport = { ok: false, failedStage: "caps", findings: capFindings }
      return report
    }

    // 3. Runtime: sandbox kernel + the pack's probes.
    const runtime = yield* runtimeStage(dir, root)
    if (!runtime.ok) return runtime
    const evidence = runtime.runtime ?? { booted: false, url: "", probes: [] }

    // 4. Invocation: how the pack asked to be tested.
    const invFindings = yield* invocationFindings(dir)
    const report: CheckReport =
      invFindings.length > 0
        ? { ok: false, failedStage: "invocation", findings: invFindings, runtime: evidence }
        : { ok: true, findings: [], runtime: evidence }
    return report
  })
