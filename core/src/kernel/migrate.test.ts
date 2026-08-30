// Unit test for the migration batch rollback. No database is opened here -- `migrateDataSchemas`
// takes its renamer as a parameter precisely so this test can fail the SECOND move with the
// first already done. The production renamer is a Postgres schema rename (QWB-44); the test
// stubs it with the same signature.
//
// The hole it closes is the same as it ever was: preflight passed, the batch started, and the
// world changed under it. A half-moved batch must be reported, and rolled back where possible.

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { MigrationFailedError, migrateDataSchemas } from "./migrate.ts"

describe("migrateDataSchemas rollback", () => {
  it("restores the first schema when the second rename throws", async () => {
    const moved: Array<[string, string]> = []
    let calls = 0
    const failingAtSecond = async (from: string, to: string) => {
      calls += 1
      if (calls === 2) throw new Error("injected fault at the second move")
      moved.push([from, to])
    }
    // Both source schemas exist, neither destination does -- a clean preflight.
    const exists = async (schema: string) =>
      schema === "bookmarks" || schema === "tags" || moved.some(([, to]) => to === schema)

    await assert.rejects(
      () =>
        migrateDataSchemas(
          [
            { fromCube: "bookmarks", toCube: "booktags/bookmarks", fromPlugin: "example-plugin" },
            { fromCube: "tags", toCube: "booktags/tags", fromPlugin: "example-plugin" },
          ],
          exists,
          failingAtSecond,
        ),
      (e: Error) => e instanceof MigrationFailedError && e.message.includes("rolled back"),
    )
    // The rollback is the same renamer, run backwards over what had MOVED: the first schema
    // is back under its old name, and the second move never happened at all -- the batch
    // stopped at the fault, exactly like the file-based test it replaces.
    assert.deepEqual(moved, [
      ["bookmarks", "booktags--bookmarks"],
      ["booktags--bookmarks", "bookmarks"],
    ])
  })

  it("refuses a batch whose destination schema already exists", async () => {
    const { MigrationConflictError } = await import("./migrate.ts")
    await assert.rejects(
      () =>
        migrateDataSchemas(
          [{ fromCube: "bookmarks", toCube: "booktags/bookmarks", fromPlugin: "example-plugin" }],
          async (schema) => schema === "bookmarks" || schema === "booktags--bookmarks",
        ),
      MigrationConflictError,
    )
  })

  it("does nothing when there is nothing to migrate", async () => {
    await migrateDataSchemas([], async () => false)
    await migrateDataSchemas(
      [{ fromCube: "ghost", toCube: "booktags/ghost", fromPlugin: "example-plugin" }],
      async () => false,
    )
  })
})
