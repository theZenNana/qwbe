#!/usr/bin/env node
// Branch naming. The repo reached 24 branches with four different naming habits at once
// (`hardening/porti-verzi`, `nota-exactoptional`, `split-probe-erp`, `web-typecheck`), which meant
// no one could tell from a name what a branch was for or whether it was still alive. One shape,
// enforced at commit time, because there is no remote and therefore no server-side hook.
//
// Usage:
//   node scripts/check-branch.mjs           the branch currently checked out
//   node scripts/check-branch.mjs <name>    a name you are about to use
//
// Exit 1 with an explanation when the name does not fit.

import { execFileSync } from "node:child_process"

/**
 * The vocabulary. Kept small on purpose: a list long enough to cover everything stops carrying
 * information. If a change genuinely fits none of these, that is worth a conversation, not a new
 * prefix invented at the keyboard.
 */
const TYPES = {
  feature: "new capability a user or another cube can see",
  fix: "restores intended behaviour that was broken",
  hardening: "gates, tests, guards, size caps - correctness of the process rather than the product",
  refactor: "same behaviour, better shape; no test should change",
  docs: "README, comments, wiki-facing text",
  test: "tests or probes only",
  experiment: "throwaway; expected to be deleted rather than merged",
  chore: "dependencies, tooling, config",
}

/** Long branches are unreadable in `git branch -vv`; two words is usually the honest summary. */
const MAX_SLUG_LENGTH = 40

/** ASCII lowercase, hyphen-separated. Same reason as scripts/check-ascii.mjs: this repo is going English. */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** Branches that exist for integration rather than work, and are exempt from the shape above. */
const RESERVED = new Set(["master", "main"])

const currentBranch = () => execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim()

const branch = process.argv[2] ?? currentBranch()

const fail = (...lines) => {
  console.error(`x branch name '${branch}' does not fit the convention\n`)
  for (const line of lines) console.error(`  ${line}`)
  console.error("\n  Shape:   <type>/<slug>")
  console.error("  Types:")
  for (const [type, meaning] of Object.entries(TYPES)) {
    console.error(`    ${type.padEnd(11)} ${meaning}`)
  }
  console.error("\n  Rename the branch you are on:  git branch -m <type>/<slug>")
  process.exit(1)
}

if (RESERVED.has(branch)) {
  console.log(`branch: '${branch}' is an integration branch`)
  process.exit(0)
}

if (branch === "HEAD") {
  // Detached HEAD during a rebase or bisect. Not a branch, nothing to name.
  console.log("branch: detached HEAD, nothing to check")
  process.exit(0)
}

const parts = branch.split("/")
if (parts.length !== 2) {
  fail(
    parts.length < 2
      ? "No type prefix. A bare name says nothing about what the branch is for."
      : "More than one '/'. Nested prefixes were tried here before and read as noise.",
  )
}

const [type, slug] = parts

if (!Object.hasOwn(TYPES, type)) {
  fail(`'${type}' is not one of the known types.`)
}

if (!SLUG.test(slug)) {
  fail(
    `'${slug}' must be lowercase ASCII words joined by single hyphens.`,
    "No diacritics, no underscores, no capitals, no trailing hyphen.",
  )
}

if (slug.length > MAX_SLUG_LENGTH) {
  fail(`'${slug}' is ${slug.length} characters; the limit is ${MAX_SLUG_LENGTH}.`)
}

console.log(`branch: '${branch}' ok`)
