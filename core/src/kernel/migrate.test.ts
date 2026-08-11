import assert from "node:assert/strict"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

// migrateDataFiles takes its renamer as a parameter precisely so this test can fail the
// SECOND move with the first already done -- no environment variable in the production path.

const dir = join(tmpdir(), `qwbe-migrate-test-${process.pid}`)
process.env.QWBE_DATA_DIR = dir

const { migrateDataFiles, MigrationFailedError } = await import("./migrate.ts")

describe("migrateDataFiles rollback", () => {
  after(() => rmSync(dir, { recursive: true, force: true }))

  it("restores the first file when the second rename throws", () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "bookmarks.sqlite"), "db")
    writeFileSync(join(dir, "bookmarks.sqlite-wal"), "wal")

    let calls = 0
    const failingAtSecond = (from: string, to: string) => {
      calls += 1
      if (calls === 2) throw new Error("injected fault at the second move")
      writeFileSync(to, "")
      rmSync(from)
    }

    assert.throws(
      () =>
        migrateDataFiles(
          [{ fromCube: "bookmarks", toCube: "booktags/bookmarks", fromPlugin: "example-plugin" }],
          failingAtSecond,
        ),
      (e: Error) => e instanceof MigrationFailedError && e.message.includes("rolled back"),
    )
    assert.ok(existsSync(join(dir, "bookmarks.sqlite")), "first file restored to its old name")
    assert.ok(existsSync(join(dir, "bookmarks.sqlite-wal")), "the wal never left")
    assert.ok(!existsSync(join(dir, "booktags--bookmarks.sqlite")), "destination absent")
  })
})
