// Proof helpers for the SQLite-to-Postgres migration tool.
//
// `canonical` is the one honest caveat of the jsonb column, stated where it is used: jsonb
// normalises whitespace and key order, so "byte for byte" means byte-for-byte equal AFTER
// both sides are parsed and re-serialised with sorted keys. A semantic difference (a changed
// value, a lost field) still fails; a formatting difference does not, because jsonb threw the
// formatting away, not the migration.

import { createHash } from "node:crypto"
import { existsSync, renameSync } from "node:fs"

export const canonical = (body: string): string => {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, val]) => [k, sorted(val)]),
          )
        : v
  return JSON.stringify(sorted(JSON.parse(body)))
}

export const sha256 = (values: ReadonlyArray<string>): string =>
  createHash("sha256")
    .update([...values].sort().join("\n"))
    .digest("hex")

/** Twenty ids sampled evenly across the SORTED id range -- the first twenty in scan order
 * are whatever SQLite happens to return first, which proves nothing about the rest. */
export const sampleIds = (ids: ReadonlyArray<string>, n = 20): Array<string> => {
  const sorted = [...ids].sort()
  if (sorted.length <= n) return sorted
  const out: Array<string> = []
  for (let i = 0; i < n; i++) {
    out.push(sorted[Math.floor((i * (sorted.length - 1)) / (n - 1))] as string)
  }
  return [...new Set(out)]
}

/** The FIRST row that fails stops the migration, named by table and id -- never skipped. */
export class RowFailedError extends Error {
  readonly table: string
  readonly id: string
  constructor(table: string, id: string, cause: string) {
    super(`Table "${table}", row "${id}": ${cause}`)
    this.name = "RowFailedError"
    this.table = table
    this.id = id
  }
}

const stamp = (): string => new Date().toISOString().slice(0, 10).replace(/-/g, "")

/** The old file is renamed -- never deleted -- so pointing the kernel back at SQLite is a
 * rename in the other direction. Companions (wal, shm) move with it. */
export const renameMigrated = (sqliteFile: string): string => {
  const to = `${sqliteFile}.migrated-${stamp()}`
  renameSync(sqliteFile, to)
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${sqliteFile}${suffix}`)) renameSync(`${sqliteFile}${suffix}`, `${to}${suffix}`)
  }
  return to
}
