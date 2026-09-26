import { join } from "node:path"
import * as FileSystem from "@effect/platform/FileSystem"
import * as NodeContext from "@effect/platform-node/NodeContext"
import { expect, layer } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { Manifest } from "../../src/kernel/manifest.ts"

// A package claiming the "auth" schema as its own history: the migration the ledger must stop.
const EVIL = {
  name: "evil-migration",
  plugin: "evil-plugin",
  definition: {
    manifest: {
      name: "evil-migration",
      tables: [],
      requiresAuth: false,
      dataMigration: [{ fromCube: "auth", toCube: "evil-migration", fromPlugin: "evil-plugin" }],
    } as unknown as Manifest,
  },
}

// ledger.ts reads QWBE_DATA_DIR at import, so the kernel modules load after it points at a temp dir.
const kernel = Effect.gen(function* () {
  const dataDir = yield* FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.makeTempDirectoryScoped()))
  process.env.QWBE_DATA_DIR = dataDir
  delete process.env.QWBE_LEGACY_MIGRATIONS
  const ledger = yield* Effect.promise(() => import("../../src/kernel/ledger.ts"))
  const { checkMigrationOwnership } = yield* Effect.promise(() => import("../../src/kernel/migrate-ownership.ts"))
  return { ...ledger, checkMigrationOwnership, ledgerFile: join(dataDir, "provenance.json") }
})

class Kernel extends Context.Tag("Kernel")<Kernel, Effect.Effect.Success<typeof kernel>>() {}

/** The error a synchronous kernel call throws; fails the test when it returns instead. */
const refusal = (run: () => unknown) => Effect.try({ try: run, catch: (e) => e as Error }).pipe(Effect.flip)

/** Writes the ledger file as `text`, or removes it when `text` is undefined. */
const plant = (text: string | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { ledgerFile } = yield* Kernel
    yield* text === undefined ? fs.remove(ledgerFile, { force: true }) : fs.writeFileString(ledgerFile, text)
  })

const ledgerText = Kernel.pipe(
  Effect.flatMap(({ ledgerFile }) => FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.readFileString(ledgerFile)))),
)

layer(Layer.scoped(Kernel, kernel).pipe(Layer.provideMerge(NodeContext.layer)), { excludeTestServices: true })((it) => {
  it.effect("an absent ledger gives no record, so the migration is refused", () =>
    Effect.gen(function* () {
      const { readLedger, checkMigrationOwnership } = yield* Kernel
      yield* plant(undefined)
      expect(readLedger()).toEqual({ state: "absent" })
      const error = yield* Effect.tryPromise(() => checkMigrationOwnership([EVIL], {})).pipe(Effect.flip)
      expect(String(error.cause)).toContain('the ledger has no record of "auth"')
    }),
  )

  for (const [label, text, reason] of [
    ["corrupt", "{ not json", "cannot be read"],
    ["wrong-shape", JSON.stringify({ auth: 42 }), 'invalid package owner for "auth"'],
  ] as const) {
    it.effect(`a ${label} ledger stops the read and stays as it was`, () =>
      Effect.gen(function* () {
        const { readLedger, LedgerCorruptError } = yield* Kernel
        yield* plant(text)
        const error = yield* refusal(readLedger)
        expect(error).toBeInstanceOf(LedgerCorruptError)
        expect(error.message).toContain(reason)
        expect(yield* ledgerText).toBe(text)
      }),
    )
  }

  it.effect("a ledger rewritten after the snapshot is refused, restored, and refused again", () =>
    Effect.gen(function* () {
      const { readLedger, verifyLedgerUnchanged, LedgerTamperedError, checkMigrationOwnership } = yield* Kernel
      yield* plant(JSON.stringify({ auth: null }))
      const snapshot = readLedger()
      yield* plant(JSON.stringify({ auth: "evil-plugin" }))
      expect(yield* refusal(() => verifyLedgerUnchanged(snapshot))).toBeInstanceOf(LedgerTamperedError)
      const restored = readLedger()
      expect(restored).toEqual({ state: "ok", ledger: { auth: null } })
      // The next boot reads the restored ledger: core owns "auth", so the claim still fails.
      const ledger = restored.state === "ok" ? restored.ledger : {}
      const error = yield* Effect.tryPromise(() => checkMigrationOwnership([EVIL], ledger)).pipe(Effect.flip)
      expect(String(error.cause)).toContain("but the ledger records core")
    }),
  )
})
