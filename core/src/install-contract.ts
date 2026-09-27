// Static contract gate for packages handed to install-from.
//
// Cube imports are relative to their installed location, so checking the administrator's
// arbitrary source directory would reject valid code for the wrong reason. The package is
// copied to a hidden directory under core but outside every discovery root, typechecked there,
// then removed. Nothing reaches the store or a discoverable destination until this check passes.

import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Command, FileSystem } from "@effect/platform"
import { Data, Effect, Stream } from "effect"
import { copyTree, walk } from "./files.ts"
import type { CubePackage } from "./kernel/manifest.ts"
import { includePackageSourcePath, isLocalSourceDirectory } from "./package-source.ts"

const here = dirname(fileURLToPath(import.meta.url))
const coreDir = resolve(here, "..")
const tsc = resolve(coreDir, "node_modules/typescript/bin/tsc")
const eslint = resolve(coreDir, "../node_modules/eslint/bin/eslint.js")

const typeScriptFiles = (root: string) =>
  Effect.map(
    walk(root, (e) => e.top && e.type === "Directory" && isLocalSourceDirectory(e.name)),
    (entries) =>
      entries
        .filter((e) => e.type === "File" && (e.name.endsWith(".ts") || e.name.endsWith(".tsx")))
        .map((e) => e.path)
        .sort(),
  )

export class PackageContractError extends Data.TaggedError("PackageContractError")<{ readonly message: string }> {
  constructor(detail: string) {
    super({ message: `refused: package failed the TypeScript contract gate:\n${detail}` })
  }
}

export const contractValidationParent = here

export const isOutsideDiscoveryRoots = (path: string): boolean =>
  [resolve(here, "cubes"), resolve(here, "../plugins")].every((root) => relative(root, path).startsWith(".."))

const text = <E>(stream: Stream.Stream<Uint8Array, E>) => stream.pipe(Stream.decodeText(), Stream.mkString)

/**
 * Run a node script to completion off the event loop, stdout and stderr drained together so a
 * chatty child never stalls on a full pipe. stdin is empty, so the child reads end-of-file.
 */
const runNodeScript = (tool: string, cwd: string, args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* Command.start(
        Command.make(process.execPath, ...args).pipe(Command.workingDirectory(cwd), Command.stdin(Stream.empty)),
      )
      const { status, stdout, stderr } = yield* Effect.all(
        { status: child.exitCode, stdout: text(child.stdout), stderr: text(child.stderr) },
        { concurrency: "unbounded" },
      )
      if (status !== 0) {
        return yield* new PackageContractError(`${stdout}${stderr}`.trim() || `${tool} exited with status ${status}`)
      }
    }),
  ).pipe(
    Effect.catchTags({
      SystemError: (e) => new PackageContractError(`${tool} could not run: ${e.message}`),
      BadArgument: (e) => new PackageContractError(`${tool} could not run: ${e.message}`),
    }),
  )

/** Typecheck a package before it becomes visible to the store or discovery. */
export const checkPackageContract = (source: string, pkg: CubePackage) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      // Scoped: the validation copy is removed when this gate ends, pass, refusal or interrupt.
      const validation = yield* fs.makeTempDirectoryScoped({
        directory: contractValidationParent,
        prefix: "qwbe-contract-",
      })
      yield* copyTree(source, validation, (path) => includePackageSourcePath(source, path))
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
      yield* fs.writeFileString(
        join(validation, "qwbe-contract-check.ts"),
        `import type { CubeDefinition } from "qwbe-core/cube"\n${imports}\n${checks}\n`,
      )
      const files = yield* typeScriptFiles(validation)
      if (files.length === 0) return yield* new PackageContractError("package contains no TypeScript source")

      // Inherit the repository's one compiler policy. `files` narrows the project to this staged
      // package and its generated assertion; all strictness/module flags remain owned by tsconfig.
      const project = join(validation, "tsconfig.json")
      yield* fs.writeFileString(
        project,
        `${JSON.stringify({ extends: join(coreDir, "tsconfig.json"), files }, null, 2)}\n`,
      )

      yield* runNodeScript("TypeScript", coreDir, [tsc, "--project", project])
      yield* runNodeScript("ESLint", resolve(coreDir, ".."), [eslint, "--no-ignore", ...files])
    }),
  )
