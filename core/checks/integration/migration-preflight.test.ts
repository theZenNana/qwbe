import { randomBytes } from "node:crypto"
import { expect, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { MigrationConflictError, migrateDataSchemas } from "../../src/kernel/migrate.ts"
import { getPool } from "../../src/pg/db.ts"
import { q, schemaExists, schemaName } from "../../src/pg/setup.ts"
import { kernelStore } from "../_layers/postgres.ts"
import { TestDb, testDb } from "../_layers/test-db.ts"

// Replaces the database half of probes/booktags-migration.mjs: preflight checks the whole batch
// before the first rename, and a migration already done is skipped. The mount rules of that
// probe need a booted server and are not ported here.
//
// A rename also renames the cluster-wide role qwbe_cube_<schema> when one exists, so every cube
// name carries this run's tag: the check can never rename a role another database relies on.
const TAG = randomBytes(4).toString("hex")
const flat = (name: string) => `${name}-${TAG}`
const nested = (cube: string) => `booktags/${cube}`

const store = Layer.scopedDiscard(Effect.flatMap(TestDb, ({ url }) => kernelStore(url))).pipe(
  Layer.provide(testDb("migration")),
)

const rowsOf = <Row extends object>(text: string, values: ReadonlyArray<unknown> = []) =>
  Effect.promise(() => getPool().query<Row>(text, [...values])).pipe(Effect.map((result) => result.rows))

/** A pre-ledger cube schema holding table `table` with the one row `row-1`, as a legacy install left it. */
const plant = (schema: string, table: string) =>
  rowsOf(`CREATE SCHEMA ${q(schema)};
    CREATE TABLE ${q(schema)}.${q(table)} (id text PRIMARY KEY, type text NOT NULL, created_at timestamptz NOT NULL,
      deleted boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1, body jsonb NOT NULL);
    INSERT INTO ${q(schema)}.${q(table)} (id, type, created_at, body) VALUES ('row-1', 'T', now(), '{}')`)

/** Moves each flat cube under booktags; a refusal arrives in the error channel. */
const migrate = (cubes: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: () =>
      migrateDataSchemas(cubes.map((cube) => ({ fromCube: cube, toCube: nested(cube), fromPlugin: "example" }))),
    catch: (refusal) => refusal,
  })

const exists = (cube: string) => Effect.promise(() => schemaExists(schemaName(cube)))

const idsIn = (cube: string, table: string) =>
  rowsOf<{ id: string }>(`SELECT id FROM ${q(schemaName(cube))}.${q(table)}`).pipe(
    Effect.map((rows) => rows.map((row) => row.id)),
  )

/** Outbox entries a rename wrote for `cube`: one per moved table, so a repeated rename would show. */
const outboxEntries = (cube: string) =>
  rowsOf<{ n: number }>(`SELECT count(*)::int AS n FROM qwbe.outbox WHERE cube = $1`, [cube]).pipe(
    Effect.map((rows) => rows[0]?.n),
  )

layer(store, { timeout: 60_000, excludeTestServices: true })("data migration preflight", (it) => {
  it.effect("a conflict on the second migration refuses the batch before the first rename", () =>
    Effect.gen(function* () {
      const [bookmarks, tags] = [flat("bookmarks"), flat("tags")]
      yield* plant(schemaName(bookmarks), "bookmarks")
      yield* plant(schemaName(tags), "tags")
      yield* plant(schemaName(nested(tags)), "tags")
      expect(yield* Effect.flip(migrate([bookmarks, tags]))).toBeInstanceOf(MigrationConflictError)
      const present = yield* Effect.forEach([bookmarks, nested(bookmarks), tags, nested(tags)], exists)
      expect(present).toEqual([true, false, true, true])
    }),
  )

  it.effect("a clean migration moves the schema with its rows", () =>
    Effect.gen(function* () {
      const links = flat("links")
      yield* plant(schemaName(links), "links")
      yield* migrate([links])
      expect(yield* exists(links)).toBe(false)
      expect(yield* idsIn(nested(links), "links")).toEqual(["row-1"])
    }),
  )

  it.effect("a second run of the same migration is a no-op", () =>
    Effect.gen(function* () {
      const pins = flat("pins")
      yield* plant(schemaName(pins), "pins")
      yield* migrate([pins])
      yield* migrate([pins])
      expect(yield* exists(pins)).toBe(false)
      expect(yield* idsIn(nested(pins), "pins")).toEqual(["row-1"])
      expect(yield* outboxEntries(nested(pins))).toBe(1)
    }),
  )
})
