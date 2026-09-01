// Drift between a store shelf and the source it came from (QWB-54 ticket 22). A shelf is
// trustworthy only while it is provably what its source holds: the provenance file records the
// fingerprint at staging, and this module re-computes both sides - the source NOW and the shelf
// NOW - against that record. Any mismatch is a verdict, not a warning: `qwbe drift` turns it
// into a failing exit code, because a silent warning is how the old store drifted unseen.
//
// Unverifiable is red too. A shelf without provenance was staged by hand - the exact disease
// this ticket removes - and a missing source cannot prove the shelf fresh.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { PROVENANCE, type Provenance, packageSourceFingerprint } from "./package-source.ts"

export type { Provenance }

/** One shelf's answer: `ok`, or red with the reason spelled out. */
export type ShelfDrift =
  | Readonly<{ name: string; status: "ok"; sourcePath: string; stagedAt: string }>
  | Readonly<{ name: string; status: "no-provenance"; detail: string }>
  | Readonly<{ name: string; status: "source-missing"; sourcePath: string; stagedAt: string; detail: string }>
  | Readonly<{ name: string; status: "drifted"; sourcePath: string; stagedAt: string; detail: string }>

/** Drift of one shelf directory. Never throws for a bad shelf - a bad shelf IS a verdict. */
export const shelfDrift = (shelfDir: string, name: string): ShelfDrift => {
  const provenancePath = join(shelfDir, PROVENANCE)
  if (!existsSync(provenancePath)) {
    return { name, status: "no-provenance", detail: `no ${PROVENANCE} - staged by hand or before provenance existed` }
  }
  let provenance: Provenance
  try {
    provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as Provenance
  } catch (error) {
    return { name, status: "no-provenance", detail: `${PROVENANCE} is not valid JSON: ${String(error)}` }
  }
  if (typeof provenance.sourcePath !== "string" || typeof provenance.fingerprint !== "string") {
    return { name, status: "no-provenance", detail: `${PROVENANCE} lacks sourcePath or fingerprint` }
  }
  const stagedAt = typeof provenance.stagedAt === "string" ? provenance.stagedAt : "unknown"
  if (!existsSync(provenance.sourcePath) || !statSync(provenance.sourcePath).isDirectory()) {
    return {
      name,
      status: "source-missing",
      sourcePath: provenance.sourcePath,
      stagedAt,
      detail: "the source is gone or not a directory - freshness cannot be proven",
    }
  }
  const reasons: string[] = []
  try {
    if (packageSourceFingerprint(provenance.sourcePath) !== provenance.fingerprint) {
      reasons.push("the source changed after staging - the copy is behind its source")
    }
  } catch (error) {
    reasons.push(`the source cannot be re-hashed: ${String(error)}`)
  }
  // The shelf's own fingerprint excludes the provenance file (bookkeeping, not content) and
  // skips NOTHING else: staging never writes authoring tooling into a shelf, so a planted
  // node_modules or any other foreign byte is a manual change -- and must answer as drift.
  if (packageSourceFingerprint(shelfDir, [PROVENANCE], false) !== provenance.fingerprint) {
    reasons.push("the store copy was changed after staging")
  }
  if (reasons.length > 0) {
    return { name, status: "drifted", sourcePath: provenance.sourcePath, stagedAt, detail: reasons.join("; ") }
  }
  return { name, status: "ok", sourcePath: provenance.sourcePath, stagedAt }
}

/** Every shelf in the store, sorted by name. Hidden staging directories are not shelves. */
export const storeDrift = (storeDir: string): ReadonlyArray<ShelfDrift> => {
  if (!existsSync(storeDir)) return []
  return readdirSync(storeDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => shelfDrift(join(storeDir, e.name), e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
}
