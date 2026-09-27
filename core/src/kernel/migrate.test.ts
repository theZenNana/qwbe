// Unit test for the migration batch rollback. No database is opened here -- `migrateDataSchemas`
// takes its renamer as a parameter precisely so this test can fail the SECOND move with the
// first already done. The production renamer is a Postgres schema rename (QWB-44); the test
// stubs it with the same signature.
//
// The hole it closes is the same as it ever was: preflight passed, the batch started, and the
// world changed under it. A half-moved batch must be reported, and rolled back where possible.

import assert from "node:assert/strict"
import { describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { MigrationConflictError, MigrationFailedError, migrateDataSchemas } from "./migrate.ts"

/** The error the migration fails with; the test fails if it succeeds instead. */
const refusal = (effect: ReturnType<typeof migrateDataSchemas>) => Effect.flip(effect)

describe("migrateDataSchemas rollback", () => {
  it.effect("restores the first schema when the second rename fails", () =>
    Effect.gen(function* () {
      const moved: Array<[string, string]> = []
      let calls = 0
      const failingAtSecond = (from: string, to: string) =>
        Effect.suspend(() => {
          calls += 1
          if (calls === 2) return Effect.fail(new Error("injected fault at the second move"))
          moved.push([from, to])
          return Effect.void
        })
      // Both source schemas exist, neither destination does -- a clean preflight.
      const exists = (schema: string) =>
        Effect.sync(() => schema === "bookmarks" || schema === "tags" || moved.some(([, to]) => to === schema))

      const e = yield* refusal(
        migrateDataSchemas(
          [
            { fromCube: "bookmarks", toCube: "booktags/bookmarks", fromPlugin: "example-plugin" },
            { fromCube: "tags", toCube: "booktags/tags", fromPlugin: "example-plugin" },
          ],
          exists,
          failingAtSecond,
        ),
      )
      assert.ok(e instanceof MigrationFailedError && e.message.includes("rolled back"))
      assert.ok(e.message.includes("injected fault at the second move"))
      // The rollback is the same renamer, run backwards over what had MOVED: the first schema
      // is back under its old name, and the second move never happened at all -- the batch
      // stopped at the fault, exactly like the file-based test it replaces.
      assert.deepEqual(moved, [
        ["bookmarks", "booktags--bookmarks"],
        ["booktags--bookmarks", "bookmarks"],
      ])
    }),
  )

  it.effect("refuses a batch whose destination schema already exists", () =>
    Effect.gen(function* () {
      const e = yield* refusal(
        migrateDataSchemas(
          [{ fromCube: "bookmarks", toCube: "booktags/bookmarks", fromPlugin: "example-plugin" }],
          (schema) => Effect.succeed(schema === "bookmarks" || schema === "booktags--bookmarks"),
        ),
      )
      assert.ok(e instanceof MigrationConflictError)
    }),
  )

  it.effect("does nothing when there is nothing to migrate", () =>
    Effect.gen(function* () {
      yield* migrateDataSchemas([], () => Effect.succeed(false))
      yield* migrateDataSchemas([{ fromCube: "ghost", toCube: "booktags/ghost", fromPlugin: "example-plugin" }], () =>
        Effect.succeed(false),
      )
    }),
  )
})
