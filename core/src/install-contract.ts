// Static contract gate for packages handed to install-from.
//
// Cube imports are relative to their installed location, so checking the administrator's
// arbitrary source directory would reject valid code for the wrong reason. The package is
// copied to a hidden directory under core but outside every discovery root, typechecked there,
// then removed. Nothing reaches the store or a discoverable destination until this check passes.

import { spawnSync } from "node:child_process"
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { CubePackage } from "./kernel/manifest.ts"
import { includePackageSourcePath, isLocalSourceDirectory } from "./package-source.ts"

const here = dirname(fileURLToPath(import.meta.url))
const coreDir = resolve(here, "..")
const tsc = resolve(coreDir, "node_modules/typescript/bin/tsc")
const eslint = resolve(coreDir, "../node_modules/eslint/bin/eslint.js")

const typeScriptFiles = (root: string): ReadonlyArray<string> => {
  const files: Array<string> = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (dir === root && entry.isDirectory() && isLocalSourceDirectory(entry.name)) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) files.push(path)
    }
  }
  walk(root)
  return files.sort()
}

export class PackageContractError extends Error {
  constructor(detail: string) {
    super(`refused: package failed the TypeScript contract gate:\n${detail}`)
    this.name = "PackageContractError"
  }
}

export const contractValidationParent = here

export const isOutsideDiscoveryRoots = (path: string): boolean =>
  [resolve(here, "cubes"), resolve(here, "../plugins")].every((root) => relative(root, path).startsWith(".."))

/** Typecheck a package before it becomes visible to the store or discovery. */
export const checkPackageContract = (source: string, pkg: CubePackage): void => {
  const validation = mkdtempSync(join(contractValidationParent, "qwbe-contract-"))
  try {
    cpSync(source, validation, { recursive: true, filter: (path) => includePackageSourcePath(source, path) })
    const entries = pkg.kind === "plugin" ? pkg.cubes.map((cube) => `./cubes/${cube}/index.ts`) : ["./index.ts"]
    const imports = entries
      .map((entry, index) => `import { cube as cube${index} } from ${JSON.stringify(entry)}`)
      .join("\n")
    const checks = entries
      .map(
        (_entry, index) =>
          `const check${index}: CubeDefinition<ReturnType<typeof cube${index}.create>["group"]> = cube${index}\nvoid check${index}`,
      )
      .join("\n")
    writeFileSync(
      join(validation, "qwbe-contract-check.ts"),
      `import type { CubeDefinition } from "qwbe-core/cube"\n${imports}\n${checks}\n`,
    )
    const files = typeScriptFiles(validation)
    if (files.length === 0) throw new PackageContractError("package contains no TypeScript source")

    // Inherit the repository's one compiler policy. `files` narrows the project to this staged
    // package and its generated assertion; all strictness/module flags remain owned by tsconfig.
    const project = join(validation, "tsconfig.json")
    writeFileSync(
      project,
      `${JSON.stringify(
        {
          extends: join(coreDir, "tsconfig.json"),
          files,
        },
        null,
        2,
      )}\n`,
    )

    const result = spawnSync(process.execPath, [tsc, "--project", project], { cwd: coreDir, encoding: "utf8" })
    if (result.error) throw new PackageContractError(`TypeScript could not run: ${result.error.message}`)
    if (result.status !== 0) {
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
      throw new PackageContractError(output || `TypeScript exited with status ${result.status}`)
    }

    const lint = spawnSync(process.execPath, [eslint, "--no-ignore", ...files], {
      cwd: resolve(coreDir, ".."),
      encoding: "utf8",
    })
    if (lint.error) throw new PackageContractError(`ESLint could not run: ${lint.error.message}`)
    if (lint.status !== 0) {
      const output = `${lint.stdout ?? ""}${lint.stderr ?? ""}`.trim()
      throw new PackageContractError(output || `ESLint exited with status ${lint.status}`)
    }
  } finally {
    rmSync(validation, { recursive: true, force: true })
  }
}
