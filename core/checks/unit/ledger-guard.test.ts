import { join } from "node:path"
import * as FileSystem from "@effect/platform/FileSystem"
import * as NodeContext from "@effect/platform-node/NodeContext"
import { expect, layer } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { QwbeConfig } from "../../src/config.ts"
import {
  type Ledger,
  LedgerCorruptError,
  type LedgerSnapshot,
  LedgerTamperedError,
  readLedger,
  verifyLedgerUnchanged,
} from "../../src/kernel/ledger.ts"
import type { Manifest } from "../../src/kernel/manifest.ts"
import { checkMigrationOwnership, MigrationOwnershipError } from "../../src/kernel/migrate-ownership.ts"
import { testConfig } from "../../src/test-config.ts"

// A package claiming the core "auth" schema as its own history: the migration the ledger stops.
// The ownership check runs before any schema is renamed (boot-storage.ts), so its refusal is
// the proof that the schema stays untouched.
const EVIL_CLAIM = [
  {
    name: "evil-migration",
    plugin: "evil-plugin",
    definition: {
      manifest: {
        name: "evil-migration",
        tables: [],
        requiresAuth: false,
        dataMigration: [{ fromCube: "auth", toCube: "evil-migration", fromPlugin: "evil-plugin" }],
      } as Manifest,
    },
  },
]

// The ledger lives in a scoped temp data directory, handed to the kernel through its config.
const ledgerFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const dataDir = yield* fs.makeTempDirectoryScoped()
  const ledgerFile = join(dataDir, "provenance.json")
  return {
    config: testConfig({ QWBE_DATA_DIR: dataDir }),
    writeLedgerFile: (text: string) => fs.writeFileString(ledgerFile, text),
    removeLedgerFile: fs.remove(ledgerFile, { force: true }),
    readLedgerFile: fs.readFileString(ledgerFile),
  }
})

class Files extends Context.Tag("checks/unit/LedgerFiles")<Files, Effect.Effect.Success<typeof ledgerFiles>>() {}

/** What main.ts hands the ownership check: the snapshot's ledger, or nothing recorded. */
const trustedLedger = (snapshot: LedgerSnapshot): Ledger => (snapshot.state === "ok" ? snapshot.ledger : {})

/** The error a synchronous kernel call throws; the test fails if the call returns instead. */
const thrownBy = (run: () => unknown) => Effect.flip(Effect.try({ try: run, catch: (error) => error }))

const claimRefusal = (ledger: Ledger) => thrownBy(() => checkMigrationOwnership(EVIL_CLAIM, ledger))

const TestLive = Layer.effect(
  QwbeConfig,
  Effect.map(Files, (files) => files.config),
).pipe(Layer.provideMerge(Layer.scoped(Files, ledgerFiles)), Layer.provideMerge(NodeContext.layer))

layer(TestLive, { excludeTestServices: true })((it) => {
  it.effect("an absent ledger records nothing, so the claim on auth is refused", () =>
    Effect.gen(function* () {
      const { removeLedgerFile } = yield* Files
      yield* removeLedgerFile
      const snapshot = yield* readLedger
      expect(snapshot).toEqual({ state: "absent" })
      const refusal = yield* claimRefusal(trustedLedger(snapshot))
      expect(refusal).toBeInstanceOf(MigrationOwnershipError)
      expect(String(refusal)).toContain('the ledger has no record of "auth"')
    }),
  )

  for (const [label, text, reason] of [
    ["corrupt", "{ not json", "cannot be read"],
    ["wrong-shape", JSON.stringify({ auth: 42 }), 'invalid package owner for "auth"'],
  ] as const) {
    it.effect(`a ${label} ledger stops the read and stays byte for byte`, () =>
      Effect.gen(function* () {
        const { writeLedgerFile, readLedgerFile } = yield* Files
        yield* writeLedgerFile(text)
        const refusal = yield* Effect.flip(readLedger)
        expect(refusal).toBeInstanceOf(LedgerCorruptError)
        expect(String(refusal)).toContain(reason)
        expect(yield* readLedgerFile).toBe(text)
      }),
    )
  }

  it.effect("a ledger rewritten after the snapshot is refused and restored, and the claim still fails", () =>
    Effect.gen(function* () {
      const { writeLedgerFile } = yield* Files
      yield* writeLedgerFile(JSON.stringify({ auth: null }))
      const snapshot = yield* readLedger
      yield* writeLedgerFile(JSON.stringify({ auth: "evil-plugin" }))
      expect(yield* Effect.flip(verifyLedgerUnchanged(snapshot))).toBeInstanceOf(LedgerTamperedError)
      // The next boot reads the restored file: core owns auth, so the claim is refused again.
      const nextBoot = yield* readLedger
      expect(nextBoot).toEqual({ state: "ok", ledger: { auth: null } })
      const refusal = yield* claimRefusal(trustedLedger(nextBoot))
      expect(refusal).toBeInstanceOf(MigrationOwnershipError)
      expect(String(refusal)).toContain("but the ledger records core")
    }),
  )
})
