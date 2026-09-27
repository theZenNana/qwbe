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
import { join } from "node:path"
import { FileSystem } from "@effect/platform"
import { Data, Effect, ParseResult, Schema } from "effect"
import { QwbeConfig } from "../config.ts"

const ledgerPathIn = (dataDir: string) => join(dataDir, "provenance.json")

export type Ledger = Record<string, string | null>
export type LedgerSnapshot = { state: "absent" } | { state: "ok"; ledger: Ledger }

const CUBE_IDENTITY = /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?$/
const PACKAGE_NAME = /^[a-z][a-z0-9-]*$/

// Only the key and the owner are checked here; the messages are the ones the operator reads.
const LedgerFile = Schema.parseJson(
  Schema.Record({ key: Schema.String, value: Schema.Unknown }).pipe(
    Schema.annotations({ message: () => "expected an object mapping cube identities to package names or null" }),
    Schema.filter((ledger) => {
      for (const [cube, plugin] of Object.entries(ledger)) {
        if (!CUBE_IDENTITY.test(cube)) return `invalid cube identity ${JSON.stringify(cube)}`
        if (plugin !== null && (typeof plugin !== "string" || !PACKAGE_NAME.test(plugin))) {
          return `invalid package owner for ${JSON.stringify(cube)}`
        }
      }
      return true
    }),
  ),
)

export class LedgerCorruptError extends Data.TaggedError("LedgerCorruptError")<{ readonly message: string }> {
  constructor(path: string, cause: string) {
    super({
      message:
        `The provenance ledger at "${path}" exists but cannot be read: ${cause}. ` +
        `A ledger that cannot be read is not an empty ledger -- every migration check would ` +
        `fail open. Remove or repair the file by hand; the kernel does not guess provenance.`,
    })
  }
}

/**
 * Read the ledger. Three states, kept distinct on purpose:
 *   - ABSENT  -- no boot ever wrote one. Legal: pre-ledger data directory, or a fresh one.
 *   - VALID   -- parsed.
 *   - INVALID -- present but unreadable: STOPS the boot, because "cannot read" must never
 *     degrade silently into "nothing recorded".
 */
const ABSENT: LedgerSnapshot = { state: "absent" }

export const readLedger = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = ledgerPathIn((yield* QwbeConfig).dataDir)
  if (!(yield* fs.exists(path))) return ABSENT
  const corrupt = (cause: string) => new LedgerCorruptError(path, cause)
  const text = yield* Effect.mapError(fs.readFileString(path), (e) => corrupt(e.message))
  const ledger = yield* Schema.decodeUnknown(LedgerFile)(text).pipe(
    Effect.mapError((e) => corrupt(ParseResult.ArrayFormatter.formatErrorSync(e)[0]?.message ?? e.message)),
  )
  // The filter above checked every key and owner; the decoded record IS a Ledger.
  const snapshot: LedgerSnapshot = { state: "ok", ledger: ledger as Ledger }
  return snapshot
})

const sameLedger = (left: Ledger, right: Ledger): boolean =>
  JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort())

/** Atomic replacement plus file/directory fsync: a successful return is crash-durable. */
const replaceLedger = (ledger: Ledger) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { dataDir } = yield* QwbeConfig
    const path = ledgerPathIn(dataDir)
    yield* fs.makeDirectory(dataDir, { recursive: true })
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
    yield* Effect.gen(function* () {
      const file = yield* fs.open(tmp, { flag: "wx", mode: 0o600 })
      yield* file.writeAll(new TextEncoder().encode(`${JSON.stringify(ledger, null, 2)}\n`))
      yield* file.sync
    }).pipe(
      Effect.scoped,
      Effect.zipRight(fs.rename(tmp, path)),
      // FileSystem.open takes a directory too: the rename itself is made durable here.
      Effect.zipRight(Effect.scoped(Effect.flatMap(fs.open(dataDir, { flag: "r" }), (directory) => directory.sync))),
      Effect.ensuring(Effect.ignore(fs.remove(tmp, { force: true }))),
    )
  })

export class LedgerTamperedError extends Data.TaggedError("LedgerTamperedError")<{ readonly message: string }> {
  constructor() {
    super({
      message:
        "The provenance ledger changed after the trusted pre-import snapshot. The trusted snapshot was restored.",
    })
  }
}

/** Detect import-time mutation and restore the trusted state before refusing boot. */
export const verifyLedgerUnchanged = (snapshot: LedgerSnapshot) =>
  Effect.gen(function* () {
    const current = yield* Effect.option(Effect.catchTag(readLedger, "LedgerCorruptError", () => Effect.fail(null)))
    const unchanged =
      current._tag === "Some" &&
      snapshot.state === current.value.state &&
      (snapshot.state === "absent" ||
        (current.value.state === "ok" && sameLedger(snapshot.ledger, current.value.ledger)))
    if (unchanged) return
    yield* replaceLedger(snapshot.state === "ok" ? snapshot.ledger : {})
    return yield* new LedgerTamperedError()
  })

/** Commit mounted ownership from the trusted snapshot; never re-read plugin-mutated state. */
export const writeLedger = (
  snapshot: LedgerSnapshot,
  entries: ReadonlyArray<{ name: string; plugin: string | null }>,
) => {
  const next: Ledger = { ...(snapshot.state === "ok" ? snapshot.ledger : {}) }
  for (const e of entries) next[e.name] = e.plugin
  return replaceLedger(next)
}
