import { join } from "node:path"
import * as FileSystem from "@effect/platform/FileSystem"
import * as NodeContext from "@effect/platform-node/NodeContext"
import { expect, layer } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { Ledger, LedgerSnapshot } from "../../src/kernel/ledger.ts"
import type { Manifest } from "../../src/kernel/manifest.ts"
import { tempDirectoryAs } from "./temp-env.ts"

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

// ledger.ts reads QWBE_DATA_DIR at import, so it loads after the variable points at a temp dir.
const loadKernel = Effect.gen(function* () {
  const dataDir = yield* tempDirectoryAs("QWBE_DATA_DIR")
  delete process.env.QWBE_LEGACY_MIGRATIONS
  const ledger = yield* Effect.promise(() => import("../../src/kernel/ledger.ts"))
  const ownership = yield* Effect.promise(() => import("../../src/kernel/migrate-ownership.ts"))
  return { ...ledger, ...ownership, ledgerFile: join(dataDir, "provenance.json") }
})

class Kernel extends Context.Tag("checks/unit/LedgerKernel")<Kernel, Effect.Effect.Success<typeof loadKernel>>() {}

/** What main.ts hands the ownership check: the snapshot's ledger, or nothing recorded. */
const trustedLedger = (snapshot: LedgerSnapshot): Ledger => (snapshot.state === "ok" ? snapshot.ledger : {})

/** The error a synchronous kernel call throws; the test fails if the call returns instead. */
const thrownBy = (run: () => unknown) => Effect.flip(Effect.try({ try: run, catch: (error) => error }))

const claimRefusal = (ledger: Ledger) =>
  Effect.flatMap(Kernel, ({ checkMigrationOwnership }) =>
    Effect.flip(Effect.tryPromise({ try: () => checkMigrationOwnership(EVIL_CLAIM, ledger), catch: (e) => e })),
  )

const writeLedgerFile = (text: string) =>
  Effect.flatMap(Effect.all([FileSystem.FileSystem, Kernel]), ([fs, k]) => fs.writeFileString(k.ledgerFile, text))

const removeLedgerFile = Effect.flatMap(Effect.all([FileSystem.FileSystem, Kernel]), ([fs, k]) =>
  fs.remove(k.ledgerFile, { force: true }),
)

const readLedgerFile = Effect.flatMap(Effect.all([FileSystem.FileSystem, Kernel]), ([fs, k]) =>
  fs.readFileString(k.ledgerFile),
)

layer(Layer.scoped(Kernel, loadKernel).pipe(Layer.provideMerge(NodeContext.layer)), { excludeTestServices: true })(
  (it) => {
    it.effect("an absent ledger records nothing, so the claim on auth is refused", () =>
      Effect.gen(function* () {
        const { readLedger, MigrationOwnershipError } = yield* Kernel
        yield* removeLedgerFile
        const snapshot = readLedger()
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
          const { readLedger, LedgerCorruptError } = yield* Kernel
          yield* writeLedgerFile(text)
          const refusal = yield* thrownBy(readLedger)
          expect(refusal).toBeInstanceOf(LedgerCorruptError)
          expect(String(refusal)).toContain(reason)
          expect(yield* readLedgerFile).toBe(text)
        }),
      )
    }

    it.effect("a ledger rewritten after the snapshot is refused and restored, and the claim still fails", () =>
      Effect.gen(function* () {
        const { readLedger, verifyLedgerUnchanged, LedgerTamperedError, MigrationOwnershipError } = yield* Kernel
        yield* writeLedgerFile(JSON.stringify({ auth: null }))
        const snapshot = readLedger()
        yield* writeLedgerFile(JSON.stringify({ auth: "evil-plugin" }))
        expect(yield* thrownBy(() => verifyLedgerUnchanged(snapshot))).toBeInstanceOf(LedgerTamperedError)
        // The next boot reads the restored file: core owns auth, so the claim is refused again.
        const nextBoot = readLedger()
        expect(nextBoot).toEqual({ state: "ok", ledger: { auth: null } })
        const refusal = yield* claimRefusal(trustedLedger(nextBoot))
        expect(refusal).toBeInstanceOf(MigrationOwnershipError)
        expect(String(refusal)).toContain("but the ledger records core")
      }),
    )
  },
)
