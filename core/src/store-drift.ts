// Drift between a store shelf and the source it came from. A shelf is
// trustworthy only while it is provably what its source holds: the provenance file records the
// fingerprint at staging, and this module re-computes both sides - the source NOW and the shelf
// NOW - against that record. Any mismatch is a verdict, not a warning: `qwbe drift` turns it
// into a failing exit code, because a silent warning is how the old store drifted unseen.
//
// Unverifiable is red too. A shelf without provenance was staged by hand - the exact disease
// this ticket removes - and a missing source cannot prove the shelf fresh.

import { join } from "node:path"
import { FileSystem } from "@effect/platform"
import { Effect, ParseResult, Schema } from "effect"
import { subdirectories } from "./files.ts"
import { PROVENANCE, Provenance, packageSourceFingerprint, shelfFingerprint } from "./package-source.ts"

/** One shelf's answer: `ok`, or red with the reason spelled out. */
type ShelfDrift =
  | Readonly<{ name: string; status: "ok"; sourcePath: string; stagedAt: string }>
  | Readonly<{ name: string; status: "no-provenance"; detail: string }>
  | Readonly<{ name: string; status: "source-missing"; sourcePath: string; stagedAt: string; detail: string }>
  | Readonly<{ name: string; status: "drifted"; sourcePath: string; stagedAt: string; detail: string }>

const isDirectory = (fs: FileSystem.FileSystem, path: string) =>
  fs.stat(path).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.orElseSucceed(() => false),
  )

/** Drift of one shelf directory. Never fails for a bad shelf - a bad shelf IS a verdict. */
export const shelfDrift = (shelfDir: string, name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const provenancePath = join(shelfDir, PROVENANCE)
    if (!(yield* fs.exists(provenancePath))) {
      return {
        name,
        status: "no-provenance",
        detail: `no ${PROVENANCE} - staged by hand or before provenance existed`,
      } satisfies ShelfDrift
    }
    const decoded = yield* fs
      .readFileString(provenancePath)
      .pipe(Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(Provenance))), Effect.either)
    if (decoded._tag === "Left") {
      const why = ParseResult.isParseError(decoded.left) ? decoded.left.message : String(decoded.left)
      return { name, status: "no-provenance", detail: `${PROVENANCE} is unreadable: ${why}` } satisfies ShelfDrift
    }
    const provenance = decoded.right
    const stagedAt = provenance.stagedAt ?? "unknown"
    if (!(yield* isDirectory(fs, provenance.sourcePath))) {
      return {
        name,
        status: "source-missing",
        sourcePath: provenance.sourcePath,
        stagedAt,
        detail: "the source is gone or not a directory - freshness cannot be proven",
      } satisfies ShelfDrift
    }
    const reasons: string[] = []
    const source = yield* Effect.either(packageSourceFingerprint(provenance.sourcePath))
    if (source._tag === "Left") reasons.push(`the source cannot be re-hashed: ${source.left.message}`)
    else if (source.right !== provenance.fingerprint) {
      reasons.push("the source changed after staging - the copy is behind its source")
    }
    // The shelf's own fingerprint goes through `shelfFingerprint` - the strict rule shared by
    // every shelf reader: it excludes the provenance file (bookkeeping, not content) and skips
    // NOTHING else, so a planted node_modules or any other foreign byte is a manual change --
    // and must answer as drift.
    if ((yield* shelfFingerprint(shelfDir)) !== provenance.fingerprint) {
      reasons.push("the store copy was changed after staging")
    }
    if (reasons.length > 0) {
      return {
        name,
        status: "drifted",
        sourcePath: provenance.sourcePath,
        stagedAt,
        detail: reasons.join("; "),
      } satisfies ShelfDrift
    }
    return { name, status: "ok", sourcePath: provenance.sourcePath, stagedAt } satisfies ShelfDrift
  })

/** Every shelf in the store, sorted by name. Hidden staging directories are not shelves. */
export const storeDrift = (storeDir: string) =>
  Effect.gen(function* () {
    const shelves = (yield* subdirectories(storeDir)).filter((n) => !n.startsWith("."))
    const verdicts: ReadonlyArray<ShelfDrift> = yield* Effect.forEach(shelves, (n) => shelfDrift(join(storeDir, n), n))
    return [...verdicts].sort((a, b) => a.name.localeCompare(b.name))
  })
