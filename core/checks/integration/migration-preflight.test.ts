import { expect, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { MigrationConflictError, migrateDataSchemas } from "../../src/kernel/migrate.ts"
import { closeAll, getPool, initStore } from "../../src/pg/db.ts"
import { q, schemaExists } from "../../src/pg/setup.ts"
import { TestDb, testDb } from "../_layers/test-db.ts"

// The kernel store on the throwaway database: env first, the pool reads it lazily.
const store = Layer.scopedDiscard(
  Effect.acquireRelease(
    TestDb.pipe(
      Effect.flatMap(({ url }) =>
        Effect.promise(() => {
          process.env.QWBE_DATABASE_URL = url
          return initStore()
        }),
      ),
    ),
    () => Effect.promise(closeAll),
  ),
).pipe(Layer.provide(testDb("migration")))

const sql = <Row extends object>(text: string) =>
  Effect.promise(() => getPool().query<Row>(text)).pipe(Effect.map((result) => result.rows))

/** A pre-ledger cube schema `cube` with table `cube` holding one row `<cube>-1`. */
const plant = (cube: string, schema = cube) =>
  sql(`CREATE SCHEMA ${q(schema)};
    CREATE TABLE ${q(schema)}.${q(cube)} (id TEXT PRIMARY KEY, type TEXT NOT NULL, created_at timestamptz NOT NULL,
      deleted BOOLEAN NOT NULL DEFAULT false, version INTEGER NOT NULL DEFAULT 1, body JSONB NOT NULL);
    INSERT INTO ${q(schema)}.${q(cube)} (id, type, created_at, body) VALUES ('${cube}-1', 'T', now(), '{}')`)

/** Moves each flat cube under booktags; a refusal arrives in the error channel. */
const migrate = (cubes: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: () =>
      migrateDataSchemas(cubes.map((cube) => ({ fromCube: cube, toCube: `booktags/${cube}`, fromPlugin: "example" }))),
    catch: (refusal) => refusal,
  })

const exists = (schema: string) => Effect.promise(() => schemaExists(schema))
const ids = (cube: string) =>
  sql<{ id: string }>(`SELECT id FROM ${q(`booktags--${cube}`)}.${q(cube)}`).pipe(
    Effect.map((rows) => rows.map((row) => row.id)),
  )

layer(store, { timeout: 60_000, excludeTestServices: true })((it) => {
  it.effect("a conflict on the second migration renames nothing", () =>
    Effect.gen(function* () {
      yield* Effect.all([plant("bookmarks"), plant("tags"), plant("tags", "booktags--tags")])
      expect(yield* Effect.flip(migrate(["bookmarks", "tags"]))).toBeInstanceOf(MigrationConflictError)
      const after = yield* Effect.all(["bookmarks", "booktags--bookmarks", "tags", "booktags--tags"].map(exists))
      expect(after).toEqual([true, false, true, true])
    }),
  )

  it.effect("a clean migration moves the row to the new schema", () =>
    Effect.gen(function* () {
      yield* plant("links")
      yield* migrate(["links"])
      expect(yield* exists("links")).toBe(false)
      expect(yield* ids("links")).toEqual(["links-1"])
    }),
  )

  it.effect("a second run of the same migration is a no-op", () =>
    Effect.gen(function* () {
      yield* plant("pins")
      yield* migrate(["pins"])
      yield* migrate(["pins"])
      expect(yield* exists("pins")).toBe(false)
      expect(yield* ids("pins")).toEqual(["pins-1"])
    }),
  )
})
