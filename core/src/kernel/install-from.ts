// Installing from a pointed directory - the one door through which a caller hands the kernel
// a PATH it did not build.
//
// The seam is the natural one: `install.ts` keeps everything that starts
// from a NAME in the store; this file keeps everything that starts from a directory on the
// administrator's filesystem and ends by asking the store flow its usual question.
//
// The source-side rules, spelled out because the rest of the kernel never sees a path:
//
//   * The path must be absolute, must resolve to a real directory, and is re-resolved with
//     realpath - a symlink AS the source would make the checks below describe one tree and
//     the copy read another.
//   * Nothing inside may be a symlink, socket, device or fifo - only plain files and plain
//     directories. A symlink inside the tree is an escape hatch: a copy follows it, and the
//     "copy" quietly reads /etc or another cube's database. Refused by shape, not by
//     blacklisting targets.
//   * Nothing is executed from the source. The kernel reads bytes; it never imports,
//     requires or spawns anything under the pointed directory.
//
// Ownership after a successful stage: the staged copy belongs to the STORE. Uninstalling the
// package removes the installed destination only - the shelf copy stays, so a reinstall does
// not need the source path and the source may disappear. Forgetting the shelf copy is a
// separate operation.

import { isAbsolute, join, sep } from "node:path"
import { FileSystem } from "@effect/platform"
import { Effect } from "effect"
import { copyTree } from "../files.ts"
import { checkPackageContract } from "../install-contract.ts"
import {
  includePackageSourcePath,
  PROVENANCE,
  packageSourceFingerprint,
  shelfFingerprint,
  validatePackageSourceTree,
} from "../package-source.ts"
import type { InstallStep } from "./install-parts.ts"
import type { CubePackage } from "./manifest.ts"

/** Same refusal type the store flow throws - re-declared here to keep the seam acyclic. */
import { InstallError } from "./manifest.ts"

/** The provenance file name lives next to the fingerprint it records (package-source.ts). */
export { InstallError, PROVENANCE }

/**
 * What stageAndInstall needs from the store flow - handed in, not imported, so this module
 * cannot reach further into the store than the seam allows.
 */
type StageContext = Readonly<{
  storeDir: string
  readPackageAt: (name: string, dir: string) => InstallStep<CubePackage>
  installExisting: (name: string) => InstallStep<CubePackage>
  /**
   * The boot-gate checker, injected (QWB-70): only discovery.ts may open the pack door, so the
   * caller hands the function in instead of this module importing it. Required, not optional:
   * an installer that skips the source-contract stage by omission is exactly the hole the
   * pack-door rule exists to close (tests pass an explicit `async () => []`).
   */
  checkPackageSource: (source: string) => Promise<ReadonlyArray<{ rule: string; file: string; message: string }>>
}>

/**
 * Stage a source directory into the store and install it from there. The source is judged
 * first (path, tree shape, manifest, source contract, TypeScript gate); nothing reaches the
 * shelf until every check passes.
 */
export const stageAndInstall =
  (ctx: StageContext) =>
  (sourceDirectory: string): InstallStep<CubePackage & { staged: boolean }> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      // 1. The path itself. Everything else follows from a path that is absolute, real and a
      //    directory - a relative path would resolve against whoever happened to be cwd.
      if (!isAbsolute(sourceDirectory)) {
        return yield* new InstallError(`refused: "${sourceDirectory}" is not an absolute path`)
      }
      if (!(yield* fs.exists(sourceDirectory))) {
        return yield* new InstallError(`refused: "${sourceDirectory}" is not an existing directory`)
      }
      // A symlink AS the root is refused by the same rule that refuses symlinks inside the tree.
      // stat would follow it, and realPath would bless the target - the checks below would
      // describe one tree while the administrator pointed at another. readLink succeeds only
      // on a link.
      const rootIsLink = yield* fs.readLink(sourceDirectory).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
      if (rootIsLink) {
        return yield* new InstallError(
          `refused: "${sourceDirectory}" is a symlink - point at the real directory, not a link to it.`,
        )
      }
      if ((yield* fs.stat(sourceDirectory)).type !== "Directory") {
        return yield* new InstallError(`refused: "${sourceDirectory}" is not a directory`)
      }
      const source = yield* fs.realPath(sourceDirectory)

      // 2. Shape of the tree - before anything is copied, so a refusal leaves zero trace.
      const invalidSource = yield* validatePackageSourceTree(source)
      if (invalidSource) {
        return yield* new InstallError(
          `refused: ${invalidSource} - a package must be plain files and directories only.`,
        )
      }

      // 3. Validate as a package straight from the source directory. The name comes from the
      //    directory's base name; the manifest, name-shape and DESTINATION-clash checks are the
      //    ones the store flow has always run. The duplicate-cube check waits for the staged copy
      //    - staging first costs nothing and refusing first would leave the difference between
      //    "bad content" and "bad timing" invisible to the caller.
      const name = source.split(sep).pop() ?? ""
      const pkg = yield* ctx.readPackageAt(name, source)
      if (pkg.installed) {
        return yield* new InstallError(
          `refused: "${name}" is already installed. ` +
            `Installing never overwrites - remove it first if that is what you meant.`,
        )
      }

      // 4. Fingerprint of the source, then the raft question: same name already staged? The
      //    shelf's fingerprint is RE-COMPUTED from the bytes on disk, never read back from the
      //    provenance file: that file records what was staged, and content edited after staging
      //    must answer as "different content", not inherit the old stamp. The shelf is hashed
      //    through `shelfFingerprint` -- the strict rule (nothing skipped beyond the provenance
      //    file) every shelf reader shares: staging never writes authoring tooling into a shelf,
      //    so tooling appearing there is different content by definition.
      const fingerprint = yield* packageSourceFingerprint(source)
      const shelfDir = join(ctx.storeDir, name)
      if (yield* fs.exists(shelfDir)) {
        if ((yield* shelfFingerprint(shelfDir)) === fingerprint) {
          // Idempotent: the raft already holds exactly this content - reuse it. The path is
          // deliberately NOT part of the decision: the same path can serve new content.
          return { ...(yield* ctx.installExisting(name)), staged: false }
        }
        return yield* new InstallError(
          `refused: the store already holds a package named "${name}" with different content. ` +
            `Remove it from the store first if this source should replace it.`,
        )
      }

      // Static contract gate after semantic name/content refusals, but before staging or
      // publication. Invalid code never reaches the shelf; an existing different package keeps
      // the more useful "different content" diagnostic.
      if (pkg.conflicts.length === 0) {
        // The source contract the kernel enforces at boot - the SAME checker,
        // so a refusal here reads exactly like the boot refusal, seen before anything is staged.
        // Cheap static scan first; the tsc gate below spawns processes. Only plugin packages,
        // like the boot gate: a cube-kind source has no cubes/ for the checker to read, and the
        // boot gate never judged one either.
        if (pkg.kind === "plugin") {
          const findings = yield* Effect.promise(() => ctx.checkPackageSource(source))
          if (findings.length > 0) {
            return yield* new InstallError(
              `refused: package breaks the source contract the kernel enforces at boot:\n` +
                findings.map((f) => `    ${f.rule}: ${f.file} -- ${f.message}`).join("\n"),
            )
          }
        }
        yield* checkPackageContract(source, pkg).pipe(
          Effect.catchTag("PackageContractError", (e) => new InstallError(e.message)),
        )
      }

      // 5. Stage under the administered directory and publish by atomic rename. The staging
      //    directory sits NEXT to the target (same filesystem, so rename is atomic) and is
      //    scoped: it is removed when this step ends, whatever the outcome.
      yield* fs.makeDirectory(ctx.storeDir, { recursive: true })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const staging = yield* fs.makeTempDirectoryScoped({ directory: ctx.storeDir, prefix: ".staging-" })
          yield* copyTree(source, join(staging, name), (path) => includePackageSourcePath(source, path))
          yield* fs.writeFileString(
            join(staging, name, PROVENANCE),
            `${JSON.stringify({ sourcePath: source, fingerprint, stagedAt: new Date().toISOString() }, null, 2)}\n`,
          )
          yield* fs.rename(join(staging, name), shelfDir)
        }),
      )

      // 6. The raft now holds the package; the existing install-by-name flow takes it from
      //    here, with its own overwrite and duplicate-cube refusals intact. A refusal here is
      //    this operation's failure too - the shelf it just published rolls back with it.
      const installed = yield* ctx
        .installExisting(name)
        .pipe(Effect.onError(() => fs.remove(shelfDir, { recursive: true, force: true }).pipe(Effect.ignore)))
      return { ...installed, staged: true }
    })
