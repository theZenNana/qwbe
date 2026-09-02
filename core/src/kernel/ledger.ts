// The provenance ledger -- who OWNS each store file, recorded by the kernel at mount.
//
// Fail-closed: a ledger that cannot be read is not an
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

import { randomUUID } from "node:crypto"
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = process.env.QWBE_DATA_DIR ?? join(here, "..", "..", "..", "data")

const ledgerPath = join(dataDir, "provenance.json")

export type Ledger = Record<string, string | null>
export type LedgerSnapshot = { state: "absent" } | { state: "ok"; ledger: Ledger }

const CUBE_IDENTITY = /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?$/
const PACKAGE_NAME = /^[a-z][a-z0-9-]*$/
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const decodeLedger = (value: unknown): Ledger => {
  if (!isRecord(value)) {
    throw new Error("expected an object mapping cube identities to package names or null")
  }
  const ledger: Ledger = {}
  for (const [cube, plugin] of Object.entries(value)) {
    if (!CUBE_IDENTITY.test(cube)) throw new Error(`invalid cube identity ${JSON.stringify(cube)}`)
    if (plugin !== null && (typeof plugin !== "string" || !PACKAGE_NAME.test(plugin))) {
      throw new Error(`invalid package owner for ${JSON.stringify(cube)}`)
    }
    ledger[cube] = plugin
  }
  return ledger
}

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
export const readLedger = (): LedgerSnapshot => {
  if (!existsSync(ledgerPath)) return { state: "absent" }
  try {
    return { state: "ok", ledger: decodeLedger(JSON.parse(readFileSync(ledgerPath, "utf8")) as unknown) }
  } catch (e) {
    throw new LedgerCorruptError((e as Error).message)
  }
}

const sameLedger = (left: Ledger, right: Ledger): boolean =>
  JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort())

/** Atomic replacement plus file/directory fsync: a successful return is crash-durable. */
const replaceLedger = (ledger: Ledger): void => {
  mkdirSync(dataDir, { recursive: true })
  const tmp = `${ledgerPath}.${process.pid}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(tmp, "wx", 0o600)
    writeFileSync(fd, `${JSON.stringify(ledger, null, 2)}\n`, "utf8")
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmp, ledgerPath)
    const directory = openSync(dataDir, "r")
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(tmp, { force: true })
  }
}

export class LedgerTamperedError extends Error {
  constructor() {
    super("The provenance ledger changed after the trusted pre-import snapshot. The trusted snapshot was restored.")
    this.name = "LedgerTamperedError"
  }
}

/** Detect import-time mutation and restore the trusted state before refusing boot. */
export const verifyLedgerUnchanged = (snapshot: LedgerSnapshot): void => {
  let current: LedgerSnapshot
  try {
    current = readLedger()
  } catch {
    replaceLedger(snapshot.state === "ok" ? snapshot.ledger : {})
    throw new LedgerTamperedError()
  }
  const unchanged =
    snapshot.state === current.state &&
    (snapshot.state === "absent" || (current.state === "ok" && sameLedger(snapshot.ledger, current.ledger)))
  if (unchanged) return
  replaceLedger(snapshot.state === "ok" ? snapshot.ledger : {})
  throw new LedgerTamperedError()
}

/** Commit mounted ownership from the trusted snapshot; never re-read plugin-mutated state. */
export const writeLedger = (
  snapshot: LedgerSnapshot,
  entries: ReadonlyArray<{ name: string; plugin: string | null }>,
): void => {
  const next: Ledger = { ...(snapshot.state === "ok" ? snapshot.ledger : {}) }
  for (const e of entries) next[e.name] = e.plugin
  replaceLedger(next)
}
