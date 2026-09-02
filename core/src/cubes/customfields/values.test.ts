// QWB-54 ticket 05 (defect 5): the values lookup for ONE row must read ONE row. This pins the
// WIRING -- `rowFields` goes through the tool's `row(cube, rowId)` (the `WHERE id = $1` reader)
// and never through `rows(cube)` (the full walk that exists for the orphan report). That the
// SQL really reads a handful of tuples rather than a whole table is measured against Postgres
// in core/src/pg/custom-caps.test.ts; the two together are the evidence the ticket asks for.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Effect } from "effect"

import type { PackTools } from "./context.ts"
import type { DefRow } from "./schema.ts"
import { rowFields } from "./values.ts"

const defRow = {
  id: "cf-1",
  type: "CustomField",
  createdAt: "2026-08-30T00:00:00.000Z",
  deleted: false,
  targetCube: "crm/contacts",
  name: "cnp",
  label: "CNP",
  fieldType: "text",
  options: [],
  required: false,
  position: 0,
} as unknown as DefRow

describe("rowFields reads one row, not the table", () => {
  it("goes through row(cube, id) and never through rows(cube)", async () => {
    let rowCalls = 0
    let rowsCalls = 0
    const tools = {
      store: { all: () => Effect.succeed([defRow]) },
      bus: {},
      catalogue: () => [],
      customFields: {
        // The scan the old implementation used per form render. If this is ever called again,
        // the count below turns red -- that is the point.
        rows: () => {
          rowsCalls += 1
          return Effect.succeed([])
        },
        row: (cube: string, rowId: string) => {
          rowCalls += 1
          assert.equal(cube, "crm/contacts")
          assert.equal(rowId, "cont-1")
          return Effect.succeed({ id: rowId, custom: { cnp: "9" }, deleted: false })
        },
      },
    } as unknown as PackTools

    const result = await Effect.runPromise(rowFields(tools, "crm/contacts", "cont-1"))
    assert.equal(result.fields[0]?.name, "cnp")
    assert.equal(result.fields[0]?.value, "9")
    assert.equal(rowCalls, 1)
    assert.equal(rowsCalls, 0)
  })

  it("a row the reader cannot find answers an empty field list, as before", async () => {
    const tools = {
      store: { all: () => Effect.succeed([defRow]) },
      bus: {},
      catalogue: () => [],
      customFields: { rows: () => Effect.succeed([]), row: () => Effect.succeed(undefined) },
    } as unknown as PackTools
    const result = await Effect.runPromise(rowFields(tools, "crm/contacts", "gone"))
    assert.deepEqual(result.fields[0]?.value, "")
  })
})
