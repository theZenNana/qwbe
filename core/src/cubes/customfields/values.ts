// The values half of the customfields handlers (QWB-46: split the file, never raise the cap).
//
// The contract these implement: values live in the TARGET row's own body under the kernel's
// reserved `custom` sub-object, written and read through the target cube's own API. So the
// lookup reads the target rows through the kernel-provided rows reader, the write VALIDATES
// ONLY -- it stores nothing, because another cube's row belongs to that cube's store -- and the
// orphan report surfaces values whose definition is gone, without ever deleting them.

import { Effect } from "effect"
import { requirePermission } from "qwbe-core/auth"
import { checkCustomValue } from "qwbe-core/custom-values"
import { BadRequest } from "qwbe-core/errors"
import { customFieldsTool, definitionsFor, type PackTools, type Snapshot } from "./context.ts"
import { displayValue, orphanValues } from "./schema.ts"

/** Definitions plus the row's current values, which is what a form actually needs. */
export const rowFields = (tools: PackTools, cube: string, rowId: string) =>
  Effect.gen(function* () {
    const customFields = customFieldsTool(tools)
    const defs = yield* definitionsFor(tools.store, cube)
    // QWB-54 ticket 05 (defect 5): ONE row's values are read with `WHERE id = $1`. The full
    // walk exists for the orphan report, which genuinely needs every row -- a form render
    // asking about one row must not scan the table and pick a row in JavaScript.
    const row = yield* customFields.row(cube, rowId)
    const custom = row?.custom ?? {}
    return {
      cube,
      rowId,
      // Driven by the DEFINITIONS, so a value left behind by a deleted field simply stops being
      // shown here rather than reappearing as a mystery column -- and is reported as an orphan
      // by the orphans report instead.
      fields: defs.map((d) => ({
        name: d.name,
        label: d.label || d.name,
        fieldType: d.fieldType,
        options: d.options,
        required: d.required,
        position: d.position,
        value: displayValue(custom[d.name]),
      })),
    }
  })

export const valuesHandlers = (tools: PackTools, _snapshot: Snapshot) => ({
  // READ: the definitions plus the target row's current values, read from the row itself. No
  // 404 for a row that does not exist: an empty field list is the honest answer to "what extra
  // fields does this row have" either way.
  valuesFor: ({ urlParams }: { urlParams: { readonly cube: string; readonly rowId: string } }) =>
    Effect.gen(function* () {
      // Review fix 12 (QWB-46): the lookup reads ANOTHER cube's rows, so it rides on THAT
      // cube's own read permission -- `customfields:read` alone would let a reader see custom
      // values on rows the target cube would refuse them.
      yield* requirePermission(`${urlParams.cube}:read`)
      return yield* rowFields(tools, urlParams.cube, urlParams.rowId)
    }),

  // VALIDATES ONLY. Custom values are saved through the target cube's own API: the kernel
  // folds undeclared keys into the row's `custom` sub-object when THAT cube's endpoints are
  // called. This endpoint stores nothing -- the response is the validated field list, not a
  // confirmation -- and every refusal happens before anything would have been written.
  setValues: ({
    payload,
  }: {
    payload: { readonly cube: string; readonly rowId: string; readonly values: Readonly<Record<string, string>> }
  }) =>
    Effect.gen(function* () {
      yield* requirePermission("customfields:read")
      const { cube, rowId, values } = payload
      // QWB-54 ticket 05 (defect 6, Opus review): this endpoint RETURNS rowFields -- the
      // target row's custom values -- so it rides on the SAME gate the lookup rides on. A
      // reader with `customfields:read` but without the target cube's own read permission
      // would otherwise read through here what `valuesFor` refuses it.
      yield* requirePermission(`${cube}:read`)
      const defs = yield* definitionsFor(tools.store, cube)
      const byName = new Map(defs.map((d) => [d.name, d]))

      const problems: Array<string> = []
      for (const [name, value] of Object.entries(values)) {
        const def = byName.get(name)
        if (!def) {
          problems.push(`"${name}" is not a field on ${cube}`)
          continue
        }
        // QWB-54 ticket 05 (defect 7, Opus review): ONE validator for the whole system -- the
        // kernel's checkCustomValue, exported through qwbe-core/custom-values. The copy that
        // lived here already diverged (it refused numeric strings on `number` and real
        // booleans on `bool`).
        const why = checkCustomValue(def, value)
        if (why) problems.push(why)
      }
      if (problems.length > 0) {
        return yield* Effect.fail(new BadRequest({ message: problems.join("; ") }))
      }
      return yield* rowFields(tools, cube, rowId)
    }),

  // The orphan report (QWB-46 step 5): values still in rows whose definition is gone. They are
  // REPORTED, never deleted -- deleting a definition must not damage existing rows.
  orphans: ({ urlParams }: { urlParams: { readonly cube: string } }) =>
    Effect.gen(function* () {
      yield* requirePermission("customfields:write")
      const cube = urlParams.cube
      // QWB-54 ticket 05 (defect 3): the report reads ANOTHER cube's rows, so it needs the
      // target cube's own read permission on top of the admin gate -- the same gate its
      // sibling lookup in this file has always required.
      yield* requirePermission(`${cube}:read`)
      const defs = yield* definitionsFor(tools.store, cube)
      const rows = yield* customFieldsTool(tools).rows(cube)
      return { cube, orphans: orphanValues(defs, rows) }
    }),
})
