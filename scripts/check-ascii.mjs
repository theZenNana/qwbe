#!/usr/bin/env node
// Source must be plain ASCII. This project was written with Romanian comments and diacritics; it is
// moving to English so that someone outside this machine can maintain it. A rule with no
// enforcement drifts back within weeks, so the check lives here.
//
// Two modes, and the difference matters:
//
//   --added     only the lines this commit ADDS. This is what the pre-commit hook runs.
//   (default)   every line of every tracked source file. This is `npm run ascii`.
//
// The hook uses --added on purpose. 114 of 130 tracked files contained non-ASCII when this was
// written, so checking whole files at commit time would block every commit until the entire
// translation is finished, and the translation is its own piece of work (wiki issue 02). Checking
// only added lines stops the problem from growing while the existing debt is paid off separately.
//
// Exit 1 with a file:line:column list when a non-ASCII byte is found outside the exemptions.

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { extname } from "node:path"

/** Only source is held to this. Markdown is prose and may be written in any language. */
const CHECKED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".json"])

/**
 * EXEMPTIONS. Every entry needs a reason on the line above it, and the reason has to say why the
 * non-ASCII is DATA rather than something a reader has to understand. An exemption without a
 * written reason is a hole in the check.
 */
const EXEMPT = [
  // Sample data for the ERP demo: Romanian contacts live in Romanian cities. These are values the
  // fixture ships, not text anyone reads in order to understand the code.
  "probes/erp-accounts.mjs",
  "probes/erp-contacts.mjs",
  // The install page speaks Romanian to its user - page.tsx carries the same prose and predates
  // the check. These strings are what the screen shows, not what a reader parses as code.
  "web/app/install/InstallFromCard.tsx",
  // Same rule, same day: the scan picker split out of InstallFromCard speaks the same Romanian
  // UI prose (checkbox labels, buttons), written the day the check already ran on the sibling.
  "web/app/install/InstallScan.tsx",
  // The baseline comments in this config record decisions in Romanian, in the owner's words -
  // historical DATA about why each number sits where it sits, not prose a code reader parses.
  "qwbe.config.json",
]

const isExempt = (file) => EXEMPT.some((allowed) => file === allowed || file.endsWith(`/${allowed}`))
const isChecked = (file) => CHECKED_EXTENSIONS.has(extname(file)) && !isExempt(file)

/** Index of the first character above ASCII, or -1. */
const firstOffender = (line) => [...line].findIndex((character) => character.codePointAt(0) > 127)

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })

/**
 * Added lines only, read from the staged diff. `-U0` gives no context lines, so every `+` line is
 * genuinely new. The `@@ -a,b +c,d @@` headers carry the new-file line numbers, which is the only
 * way to report a position a human can jump to.
 */
const scanAddedLines = () => {
  const diff = git("diff", "--cached", "-U0", "--diff-filter=ACMR")
  const findings = []
  let file = null
  let lineNumber = 0

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4)
      file = path === "/dev/null" ? null : path.replace(/^b\//, "")
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line)
    if (hunk) {
      lineNumber = Number(hunk[1])
      continue
    }
    // `+++` is handled above; a bare `+` is content.
    if (!line.startsWith("+")) continue
    const content = line.slice(1)
    if (file && isChecked(file)) {
      const column = firstOffender(content)
      if (column !== -1) {
        findings.push({ file, line: lineNumber, column: column + 1, text: content.trim().slice(0, 80) })
      }
    }
    lineNumber += 1
  }
  return findings
}

/** Whole files, for the eventual sweep. */
const scanWholeFiles = (files) => {
  const findings = []
  for (const file of files) {
    let text
    try {
      text = readFileSync(file, "utf8")
    } catch {
      continue // staged deletions leave paths that no longer exist
    }
    text.split("\n").forEach((line, index) => {
      // First offending column per line only: listing every character on a line of prose buries the
      // file names, and the fix is the same either way, which is to rewrite the line.
      const column = firstOffender(line)
      if (column !== -1) {
        findings.push({ file, line: index + 1, column: column + 1, text: line.trim().slice(0, 80) })
      }
    })
  }
  return findings
}

const args = process.argv.slice(2)
const addedOnly = args.includes("--added")
const explicitFiles = args.filter((argument) => !argument.startsWith("--"))

let findings
let scope
if (addedOnly) {
  findings = scanAddedLines()
  scope = "added lines"
} else {
  const files = (explicitFiles.length > 0 ? explicitFiles : git("ls-files").split("\n").filter(Boolean)).filter(
    isChecked,
  )
  findings = scanWholeFiles(files)
  scope = `${files.length} files`
}

if (findings.length === 0) {
  console.log(`ascii: clean (${scope})`)
  process.exit(0)
}

console.error(`ascii: ${findings.length} line(s) contain non-ASCII characters (${scope})\n`)
for (const finding of findings) {
  console.error(`  ${finding.file}:${finding.line}:${finding.column}  ${finding.text}`)
}
console.error("\nRewrite these lines in ASCII English. If the characters are DATA rather than prose,")
console.error("add the file to EXEMPT in scripts/check-ascii.mjs together with the reason.")
process.exit(1)
