// Unit test for table ownership. No database is opened here — `checkUniqueTables` reads
// manifests, and that is the point: the check runs before any connection exists.
//
// The hole it closes is legal by construction: `notes` declaring `tables: ["accounts"]` has a
// perfectly valid manifest and walks straight around the one-owner rule. Nothing about it looks
// wrong at review, which is exactly why it is refused mechanically.

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { checkUniqueTables, DuplicateTableError } from "./store.ts"

describe("checkUniqueTables", () => {
  it("accepts cubes owning distinct tables", () => {
    assert.doesNotThrow(() =>
      checkUniqueTables([
        { name: "notes", tables: ["notes"] },
        { name: "account", tables: ["accounts", "sessions"] },
      ]),
    )
  })

  it("accepts a cube owning no tables", () => {
    assert.doesNotThrow(() => checkUniqueTables([{ name: "cli", tables: [] }]))
  })

  it("accepts an empty system", () => {
    assert.doesNotThrow(() => checkUniqueTables([]))
  })

  it("refuses two cubes declaring the same table", () => {
    assert.throws(
      () =>
        checkUniqueTables([
          { name: "notes", tables: ["accounts"] },
          { name: "account", tables: ["accounts"] },
        ]),
      DuplicateTableError,
    )
  })

  it("names the table and every cube claiming it", () => {
    assert.throws(
      () =>
        checkUniqueTables([
          { name: "notes", tables: ["accounts"] },
          { name: "account", tables: ["accounts"] },
          { name: "erp", tables: ["accounts"] },
        ]),
      /Table "accounts" is declared by more than one cube: notes, account, erp/,
    )
  })

  it("refuses a cube declaring the same table twice", () => {
    assert.throws(() => checkUniqueTables([{ name: "notes", tables: ["notes", "notes"] }]), DuplicateTableError)
  })

  it("treats names that differ only in case as different tables", () => {
    assert.doesNotThrow(() =>
      checkUniqueTables([
        { name: "notes", tables: ["notes"] },
        { name: "account", tables: ["Notes"] },
      ]),
    )
  })
})
