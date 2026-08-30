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

import type { PackageFinding } from "./package-contract-scan.ts"
import { importFindings, manifestFindings, readOnlyFindings, walkSources } from "./package-contract-scan.ts"

export type { PackageFinding }

export type PackageContractOptions = {
  /** Refuse write-shaped surface: mutating endpoints and file writes. Used by agents-tools. */
  readonly readOnly?: boolean
  /** Enforce parent/child cube hierarchy: parent screen, child parent + dataMigration. Used by crm-pack. */
  readonly hierarchy?: boolean
}

const hierarchyFindings = async (root: string, cubes: readonly string[]): Promise<PackageFinding[]> => {
  const findings: PackageFinding[] = []
  const manifests = new Map<
    string,
    { readonly parent?: unknown; readonly screen?: unknown; readonly dataMigration?: unknown }
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
    if (manifest?.screen !== true) {
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
  const { findings: manifest, cubes } = manifestFindings(root)
  const files = existsSync(join(root, "cubes")) ? walkSources(root) : []
  const rest = [...importFindings(root, files)]
  if (options.readOnly) rest.push(...readOnlyFindings(root, files))
  if (options.hierarchy) rest.push(...(await hierarchyFindings(root, cubes)))
  return [...manifest, ...rest]
}
