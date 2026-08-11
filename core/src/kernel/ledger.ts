// The provenance ledger -- who OWNS each store file, recorded by the kernel at mount.
//
// Split out of migrate.ts on 2026-08-11 (size cap -- "split the file, don't raise the number").
//
// A manifest can SAY anything. The answer to "whose file is this" must come from somewhere
// the manifest cannot write: the kernel records, at every mount, which package owned which
// cube's store file. That record is the ONLY source of provenance a migration trusts. Without
// it, the attack is trivial: declare `fromCube: "auth"`, boot with `auth` excluded from
// QWBE_MOUNTED -- the victim is absent from the mounted map, every check passes, and the
// file moves.
//
// Written AFTER a successful mount (main.ts), so the ledger always describes a state that
// really ran.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = process.env.QWBE_DATA_DIR ?? join(here, "..", "..", "..", "data")

const ledgerPath = join(dataDir, "provenance.json")

export type Ledger = Record<string, string | null>

export const readLedger = (): Ledger => {
  if (!existsSync(ledgerPath)) return {}
  try {
    return JSON.parse(readFileSync(ledgerPath, "utf8")) as Ledger
  } catch {
    return {}
  }
}

export const writeLedger = (entries: ReadonlyArray<{ name: string; plugin: string | null }>): void => {
  const next: Ledger = { ...readLedger() }
  for (const e of entries) next[e.name] = e.plugin
  writeFileSync(ledgerPath, JSON.stringify(next, null, 2))
}
