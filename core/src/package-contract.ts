// The package contract, as one checker any pack runs from its own directory.
//
// Until now the contract lived as two nearly identical `source-contract.test.mjs` copies, one
// per pack, each restating the rules by hand. Copies drift. This module is the single
// statement of the rules; a pack's test file shrinks to "run the checker, expect no findings",
// plus whatever the pack alone cares about.
//
// A finding is one broken rule at one file: `{ rule, file, message }`. No finding means the
// package keeps its side of the contract. Nothing here runs the pack's own tests or the
// runtime probes -- those stay the pack's job; this only judges the source boundary.
//
// One carve-out, everywhere: a top-level `frontend/` directory in a package is outside the
// contract. It is skipped by the size gate (`probes/size-lib.mjs`) and by every rule below.

import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { pluginsDir } from "./kernel/scan.ts"
import type { PackageFinding } from "./package-contract-scan.ts"
import { importFindings, manifestFindings, readOnlyFindings, walkSources } from "./package-contract-scan.ts"

export type { PackageFinding }

export type PackageContractOptions = {
  /** Refuse write-shaped surface: mutating endpoints and file writes. Used by agents-tools. */
  readonly readOnly?: boolean
  /** Enforce parent/child cube hierarchy: parent screen, child parent + dataMigration. Used by crm-pack. */
  readonly hierarchy?: boolean
  /** Read the manifest from here instead of `root`, and cross-check it against `root`'s cubes.
   *  Only the boot gate needs it: the installer keeps a package's manifest in the store and
   *  copies the cubes alone (`isBookkeeping` in kernel/install.ts). */
  readonly manifestRoot?: string | undefined
}

const hierarchyFindings = async (root: string, cubes: readonly string[]): Promise<PackageFinding[]> => {
  const findings: PackageFinding[] = []
  const manifests = new Map<
    string,
    { readonly name?: unknown; readonly parent?: unknown; readonly screen?: unknown; readonly dataMigration?: unknown }
  >()
  for (const name of cubes) {
    const entry = join(root, "cubes", ...name.split("/"), "index.ts")
    if (!existsSync(entry)) continue
    try {
      const mod = (await import(pathToFileURL(entry).href)) as Record<string, unknown>
      // A cube is whatever the module exports that carries a manifest -- `cube` on the packs
      // that use the qwbe-core/cube helper, any name on a hand-rolled one.
      const manifest = Object.values(mod).find(
        (v): v is { manifest?: Record<string, unknown> } => typeof v === "object" && v !== null && "manifest" in v,
      )?.manifest
      if (manifest) manifests.set(name, manifest)
      else
        findings.push({
          rule: "hierarchy",
          file: `cubes/${name}/index.ts`,
          message: "module does not export a cube with a manifest",
        })
    } catch (error) {
      findings.push({
        rule: "hierarchy",
        file: `cubes/${name}/index.ts`,
        message: `cube module cannot be imported: ${String(error)}`,
      })
    }
  }
  const parents = cubes.filter((c) => !c.includes("/"))
  for (const parent of parents) {
    const manifest = manifests.get(parent)
    // No manifest was already reported by the import loop above (module absent, broken, or
    // exporting nothing) -- piling a misleading "must declare screen: true" on top of it
    // would send the pack author hunting the wrong rule.
    if (!manifest) continue
    if (manifest.screen !== true) {
      findings.push({
        rule: "hierarchy",
        file: `cubes/${parent}/index.ts`,
        message: "parent cube must declare screen: true",
      })
    }
  }
  for (const child of cubes.filter((c) => c.includes("/"))) {
    const parentName = child.split("/")[0] ?? ""
    const manifest = manifests.get(child)
    if (!manifest) continue
    if (manifest.parent !== parentName) {
      findings.push({
        rule: "hierarchy",
        file: `cubes/${child}/index.ts`,
        message: `child cube must declare parent: "${parentName}"`,
      })
    }
    if (!Array.isArray(manifest.dataMigration) || manifest.dataMigration.length === 0) {
      findings.push({
        rule: "hierarchy",
        file: `cubes/${child}/index.ts`,
        message: "child cube must declare dataMigration",
      })
    }
  }
  // A cube is addressed by its path; its manifest must say the same thing. The old per-pack
  // test copies pinned `manifest.name` by hand; now every pack gets the check for free.
  for (const name of cubes) {
    const manifest = manifests.get(name)
    const expected = name.split("/").pop()
    if (manifest && manifest.name !== expected) {
      findings.push({
        rule: "hierarchy",
        file: `cubes/${name}/index.ts`,
        message: `cube manifest.name must be "${expected}"`,
      })
    }
  }
  return findings
}

/**
 * Check a package source tree against the contract. `root` is the directory holding
 * `qwbe-package.json` and `cubes/`. A top-level `frontend/` directory is skipped by every rule.
 */
export const checkPackageSource = async (
  root: string,
  options: PackageContractOptions = {},
): Promise<PackageFinding[]> => {
  const { findings: manifest, cubes } = manifestFindings(options.manifestRoot ?? root, root)
  const files = existsSync(join(root, "cubes")) ? walkSources(root) : []
  const rest = [...importFindings(root, files)]
  if (options.readOnly) rest.push(...readOnlyFindings(root, files))
  if (options.hierarchy) rest.push(...(await hierarchyFindings(root, cubes)))
  return [...manifest, ...rest]
}

// Where to read a mounted package's manifest. Normally it sits next to the cubes -- but an
// INSTALLED package has none there: the installer treats `qwbe-package.json` as store
// bookkeeping and strips it from the copy it lands in plugins/ (pinned by
// probes/install-from.mjs). So the fallback is the store copy, cross-checked against the cubes
// really on disk, which still catches a directory added after the install. `QWBE_STORE_DIR` is
// the same override kernel/install.ts honours, read per call because probes set it per server.
const manifestRootFor = (root: string, plugin: string): string | undefined => {
  if (existsSync(join(root, "qwbe-package.json"))) return undefined
  // BOTH stores, override first. The override exists so a probe can plant a store of its own;
  // it is not a statement that the real store stopped existing. Reading only the override
  // stopped the whole kernel the first time a probe pointed `QWBE_STORE_DIR` at an empty temp
  // directory while an ALREADY INSTALLED package kept its manifest in the real one --
  // `probes/permissions.mjs`, on a machine with crm-pack installed. The boot refused with
  // "package manifest is missing" about a package that was perfectly fine.
  for (const store of [process.env.QWBE_STORE_DIR, join(pluginsDir, "..", "store")]) {
    if (store === undefined) continue
    const candidate = join(store, plugin)
    if (existsSync(join(candidate, "qwbe-package.json"))) return candidate
  }
  return undefined
}

/**
 * The boot gate (QWB-54). Until now the contract was a test a pack CHOSE to run from its own
 * repository -- and a pack that chose not to simply wrote weaker rules of its own, which is
 * exactly what happened. The kernel now runs the same checker itself, over every package a
 * mount is about to load, in every mode: a pack cannot skip a check it does not execute.
 *
 * Called from `loadDefinitions` BEFORE the first `import()` of a plugin module, so a package
 * that breaks the contract never gets to run its top-level code. A finding stops the boot.
 *
 * `hierarchy` is deliberately NOT enabled here: it imports the pack's cube modules to read
 * their manifests, which is the very execution this gate runs ahead of -- and the kernel
 * checks the manifest against the directory anyway, in `loadDefinitions`.
 */
export const assertPackageContracts = async (
  mounting: ReadonlyArray<{ readonly plugin: string | null }>,
): Promise<void> => {
  for (const plugin of new Set(mounting.map((c) => c.plugin).filter((p): p is string => p !== null))) {
    const root = join(pluginsDir, plugin)
    const findings = await checkPackageSource(root, { manifestRoot: manifestRootFor(root, plugin) })
    if (findings.length > 0) {
      throw new Error(
        `Package "${plugin}" breaks the package contract, so the kernel does not start:\n` +
          findings.map((f) => `    ${f.rule}: ${f.file} -- ${f.message}`).join("\n") +
          `\n  Fix the package, or remove it from plugins/. See docs/package-contract.md.`,
      )
    }
  }
}
