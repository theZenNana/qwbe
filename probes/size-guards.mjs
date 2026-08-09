// May this checkout rewrite the baseline?
//
// Split out of sizecaps.mjs when the guards pushed it over its own 6000-char cap — the gate that
// enforces the rule does not get to be the exception. It also reads better apart: sizecaps.mjs
// MEASURES, this file decides whether the measurement is fit to be recorded.
//
// Both refusals come from one fact: `--update-baseline` writes caps for files that are on DISK,
// committed or not. So the numbers depend on which files the running checkout can see, and on
// whether that checkout is holding unsaved work.
//
//   linked worktree   — cannot SEE another checkout's untracked files, whose caps live in the
//                       same config. Rewriting from there drops them silently, and the work
//                       reappears as brand-new violations the day it is committed.
//   dirty tree        — CAN see its own unsaved work and measures it. That is how the `kernel`
//                       unit came to read 51049: an uncommitted +1242 in install.ts, frozen into
//                       a number everyone else reads as the repository's.
//
// Found on 3 Aug 2026. Six baseline entries were read as debt for deleted files — `git ls-tree`
// on every branch found nothing, the right answer to the wrong question — and were in fact
// erp-pack and customfields-pack, alive and uncommitted in the main checkout. Seven, counting the
// one that escaped the count.

import { execFileSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { join } from "node:path"

const LIST_LIMIT = 8

// git that SAYS "not a git repository" is information; git that cannot run is not. Reporting the
// second as "clean" is the same lie the whole gate exists to prevent, so it is refused instead.
//
// And the FIRST is not "clean" either, which is the correction to make here. `not a git
// repository` was mapped to "no uncommitted paths", so in an export or a tarball the tool went
// on and rewrote the baseline — measured on 3 Aug in a directory with no `.git` and no parent
// repository: exit 0, config rewritten. There is nothing to record honestly where nothing is
// committed: the caps describe a repository, and there is none.
const uncommittedIn = (root) => {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })
    return { paths: out.split("\n").filter(Boolean) }
  } catch (err) {
    const said = `${err.stderr ?? ""}${err.stdout ?? ""}`
    if (said.includes("not a git repository")) return { noRepo: true }
    return { unreadable: said.trim() || err.message }
  }
}

/**
 * @returns {{ok: true, dirty: string[]} | {ok: false, reason: string}}
 *   `dirty` lists the uncommitted paths that WILL be measured — empty unless --dirty-ok was given.
 */
export const mayRewriteBaseline = (root, { dirtyOk = false } = {}) => {
  // `.git` as a FILE is a linked worktree; as a directory, the main checkout. Missing entirely
  // means this is not a working copy at all (an export, a tarball) — not a worktree, so it passes
  // here and the second guard decides. `statSync` alone would throw ENOENT and kill the tool.
  const dotGit = existsSync(join(root, ".git")) ? statSync(join(root, ".git")) : null
  if (dotGit?.isFile()) {
    return {
      ok: false,
      reason:
        `Refusing to rewrite the baseline from a linked worktree (${root}).\n` +
        "It cannot see untracked work in other checkouts, whose caps live in this same file.\n" +
        "Run it from the main checkout, or edit the affected numbers by hand — three digits in a\n" +
        "diff can be read; a regenerated file cannot.",
    }
  }

  const status = uncommittedIn(root)
  if (status.noRepo) {
    return {
      ok: false,
      reason:
        "Refusing: there is no repository here, so nothing can be called committed.\n" +
        "The baseline records what a repository contains — run it where there is one.",
    }
  }
  if (status.unreadable) {
    return {
      ok: false,
      reason: `Refusing: git could not be read here, so "clean" is unknown, not true.\n  ${status.unreadable}`,
    }
  }
  if (status.paths.length > 0 && !dirtyOk) {
    const shown = status.paths
      .slice(0, LIST_LIMIT)
      .map((l) => `  ${l}`)
      .join("\n")
    const more = status.paths.length > LIST_LIMIT ? `\n  … and ${status.paths.length - LIST_LIMIT} more` : ""
    return {
      ok: false,
      reason:
        `Refusing to rewrite the baseline from a tree with ${status.paths.length} uncommitted change(s):\n` +
        `${shown}${more}\n` +
        "Those files WOULD be measured, so the caps would record work no commit contains.\n" +
        "Commit first, or pass --dirty-ok to record them on purpose — it is written into the file.",
    }
  }
  return { ok: true, dirty: status.paths.map((l) => l.slice(3)).sort() }
}
