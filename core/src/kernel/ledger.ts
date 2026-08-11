// The provenance ledger -- who OWNS each store file, recorded by the kernel at mount.
//
// Split out of migrate.ts on 2026-08-11 (size cap -- "split the file, don't raise the number").
// Made fail-closed the same day after review round 4: a ledger that cannot be read is not an
// empty ledger, it is a stopped boot.
//
// A manifest can SAY anything. The answer to "whose file is this" must come from somewhere the
// manifest cannot write: the kernel records, at every mount, which package owned which cube's
// store file. That record is the ONLY source of provenance a migration trusts. Without it, the
// attack is trivial: declare `fromCube: "auth"`, boot with `auth` excluded from QWBE_MOUNTED --
// the victim is absent from the mounted map, every check passes, and the file moves.
//
// Written AFTER a successful mount (main.ts), atomically (tmp + rename), so the ledger always
// describes a state that really ran -- and a crash mid-write never leaves a torn file behind.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = process.env.QWBE_DATA_DIR ?? join(here, "..", "..", "..", "data")

const ledgerPath = join(dataDir, "provenance.json")

export type Ledger = Record<string, string | null>

export class LedgerCorruptError extends Error {
  constructor(cause: string) {
    super(
      `The provenance ledger at "${ledgerPath}" exists but cannot be read: ${cause}. ` +
        `A ledger that cannot be read is not an empty ledger -- every migration check would ` +
        `fail open. Remove or repair the file by hand; the kernel does not guess provenance.`,
    )
    this.name = "LedgerCorruptError"
  }
}

/**
 * Read the ledger. Three states, kept distinct on purpose:
 *   - ABSENT  -- no boot ever wrote one. Legal: pre-ledger data directory, or a fresh one.
 *   - VALID   -- parsed.
 *   - INVALID -- present but unreadable: STOPS the boot, because "cannot read" must never
 *     degrade silently into "nothing recorded".
 */
export const readLedger = (): { state: "absent" } | { state: "ok"; ledger: Ledger } => {
  if (!existsSync(ledgerPath)) return { state: "absent" }
  try {
    return { state: "ok", ledger: JSON.parse(readFileSync(ledgerPath, "utf8")) as Ledger }
  } catch (e) {
    throw new LedgerCorruptError((e as Error).message)
  }
}

/** Atomic: the rename is the commit. A torn write is a file that never existed. */
export const writeLedger = (entries: ReadonlyArray<{ name: string; plugin: string | null }>): void => {
  const current = readLedger()
  const next: Ledger = { ...(current.state === "ok" ? current.ledger : {}) }
  for (const e of entries) next[e.name] = e.plugin
  const tmp = `${ledgerPath}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2))
  renameSync(tmp, ledgerPath)
}
