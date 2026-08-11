// Installing from a pointed directory - the one door through which a caller hands the kernel
// a PATH it did not build.
//
// Split out of `install.ts` on 10 Aug 2026, when that file stood at 10127 code characters
// against a 6000 cap. The seam is the natural one: `install.ts` keeps everything that starts
// from a NAME in the store; this file keeps everything that starts from a directory on the
// administrator's filesystem and ends by asking the store flow its usual question.
//
// The source-side rules, spelled out because the rest of the kernel never sees a path:
//
//   * The path must be absolute, must resolve to a real directory, and is re-resolved with
//     realpath - a symlink AS the source would make the checks below describe one tree and
//     the copy read another.
//   * Nothing inside may be a symlink, socket, device or fifo - only plain files and plain
//     directories. A symlink inside the tree is an escape hatch: cpSync follows it, and the
//     "copy" quietly reads /etc or another cube's database. Refused by shape, not by
//     blacklisting targets.
//   * Nothing is executed from the source. The kernel reads bytes; it never imports,
//     requires or spawns anything under the pointed directory.
//
// Ownership after a successful stage: the staged copy belongs to the STORE. Uninstalling the
// package removes the installed destination only - the shelf copy stays, so a reinstall does
// not need the source path and the source may disappear. Forgetting the shelf is a separate,
// future operation (decided on QWB-15).

import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { isAbsolute, join, relative, sep } from "node:path"
import { checkPackageContract, PackageContractError } from "../install-contract.ts"
import type { CubePackage } from "./manifest.ts"

/** Same refusal type the store flow throws - re-declared here to keep the seam acyclic. */
export class InstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InstallError"
  }
}

/** Provenance of a staged package: where it came from and what it contained, fingerprinted. */
export const PROVENANCE = "qwbe-source.json"

/**
 * What stageAndInstall needs from the store flow - handed in, not imported, so this module
 * cannot reach further into the store than the seam allows.
 */
export type StageContext = Readonly<{
  storeDir: string
  readPackageAt: (name: string, dir: string) => CubePackage
  installExisting: (name: string) => CubePackage
}>

/**
 * A deterministic fingerprint of a directory tree: sha256 over the sorted list of
 * (relative path, file hash). Two directories with the same content fingerprint alike
 * regardless of where they sit, which is what makes "same package again" decidable without
 * trusting the source path - the path can stay while the content changes under it.
 *
 * `exclude` names top-level files that are bookkeeping, not content: the provenance file
 * records the fingerprint the shelf HAD at staging time, so hashing it into the shelf's
 * fingerprint would be circular - and trusting it without re-hashing would let edited shelf
 * content pass as identical (the review finding that put this parameter here).
 */
const fingerprintOf = (dir: string, exclude?: ReadonlyArray<string>): string => {
  const entries: Array<string> = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (exclude && d === dir && exclude.includes(e.name)) continue
      if (e.isDirectory()) walk(p)
      else entries.push(`${relative(dir, p)}:${createHash("sha256").update(readFileSync(p)).digest("hex")}`)
    }
  }
  walk(dir)
  return createHash("sha256").update(entries.sort().join("\n")).digest("hex")
}

const checkSourceTree = (root: string) => {
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      const st = lstatSync(p)
      if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) {
        throw new InstallError(
          `refused: "${p}" is ${st.isSymbolicLink() ? "a symlink" : "a special file"} - ` +
            `a package must be plain files and directories only.`,
        )
      }
      if (st.isDirectory()) walk(p)
    }
  }
  walk(root)
}

export const stageAndInstall =
  (ctx: StageContext) =>
  (sourceDirectory: string): CubePackage & { staged: boolean } => {
    // 1. The path itself. Everything else follows from a path that is absolute, real and a
    //    directory - a relative path would resolve against whoever happened to be cwd.
    if (!isAbsolute(sourceDirectory)) {
      throw new InstallError(`refused: "${sourceDirectory}" is not an absolute path`)
    }
    if (!existsSync(sourceDirectory)) {
      throw new InstallError(`refused: "${sourceDirectory}" is not an existing directory`)
    }
    // lstat, not stat: a symlink AS the root is refused by the same rule that refuses symlinks
    // inside the tree. statSync would follow it, and realpathSync would bless the target - the
    // checks below would describe one tree while the administrator pointed at another.
    const rootStat = lstatSync(sourceDirectory)
    if (rootStat.isSymbolicLink()) {
      throw new InstallError(
        `refused: "${sourceDirectory}" is a symlink - point at the real directory, not a link to it.`,
      )
    }
    if (!rootStat.isDirectory()) {
      throw new InstallError(`refused: "${sourceDirectory}" is not a directory`)
    }
    const source = realpathSync(sourceDirectory)

    // 2. Shape of the tree - before anything is copied, so a refusal leaves zero trace.
    checkSourceTree(source)

    // 3. Validate as a package straight from the source directory. The name comes from the
    //    directory's base name; the manifest, name-shape and DESTINATION-clash checks are the
    //    ones the store flow has always run. The duplicate-cube check waits for the staged copy
    //    - staging first costs nothing and refusing first would leave the difference between
    //    "bad content" and "bad timing" invisible to the caller.
    const name = source.split(sep).pop()!
    const pkg = ctx.readPackageAt(name, source)
    if (pkg.installed) {
      throw new InstallError(
        `refused: "${name}" is already installed. ` +
          `Installing never overwrites - remove it first if that is what you meant.`,
      )
    }

    // 4. Fingerprint of the source, then the raft question: same name already staged? The
    //    shelf's fingerprint is RE-COMPUTED from the bytes on disk, never read back from the
    //    provenance file: that file records what was staged, and content edited after staging
    //    must answer as "different content", not inherit the old stamp.
    const fingerprint = fingerprintOf(source)
    const shelfDir = join(ctx.storeDir, name)
    if (existsSync(shelfDir)) {
      const prior = fingerprintOf(shelfDir, [PROVENANCE])
      if (prior === fingerprint) {
        // Idempotent: the raft already holds exactly this content - reuse it. The path is
        // deliberately NOT part of the decision: the same path can serve new content.
        return { ...ctx.installExisting(name), staged: false }
      }
      throw new InstallError(
        `refused: the store already holds a package named "${name}" with different content. ` +
          `Remove it from the store first if this source should replace it.`,
      )
    }

    // Static contract gate after semantic name/content refusals, but before staging or
    // publication. Invalid code never reaches the shelf; an existing different package keeps
    // the more useful "different content" diagnostic.
    if (pkg.conflicts.length === 0) {
      try {
        checkPackageContract(source, pkg)
      } catch (error) {
        if (error instanceof PackageContractError) throw new InstallError(error.message)
        throw error
      }
    }

    // 5. Stage under the administered directory and publish by atomic rename. The staging
    //    directory sits NEXT to the target (same filesystem, so rename is atomic) and any
    //    failure before the rename removes what this operation created - no partial shelf.
    mkdirSync(ctx.storeDir, { recursive: true })
    const staging = mkdtempSync(join(ctx.storeDir, ".staging-"))
    let staged = false
    try {
      cpSync(source, join(staging, name), { recursive: true })
      writeFileSync(
        join(staging, name, PROVENANCE),
        `${JSON.stringify({ sourcePath: source, fingerprint, stagedAt: new Date().toISOString() }, null, 2)}\n`,
      )
      renameSync(join(staging, name), shelfDir)
      staged = true

      // 6. The raft now holds the package; the existing install-by-name flow takes it from
      //    here, with its own overwrite and duplicate-cube refusals intact. A refusal here is
      //    this operation's failure too - the shelf it just published rolls back with it.
      return { ...ctx.installExisting(name), staged: true }
    } catch (e) {
      if (staged) rmSync(shelfDir, { recursive: true, force: true })
      throw e
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }
