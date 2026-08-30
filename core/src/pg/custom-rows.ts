// The custom-value ROW READER for the one cube declaring `providesCustomFields` (QWB-46).
//
// Split out of pg/store.ts on 30 Aug 2026 (size cap -- the rule is "split the file, never raise
// the cap"), and rewritten over SQL for review fix 10: the first version loaded EVERY live row
// of the target cube into memory and filtered in JavaScript -- per form render, against a
// ~74k-row cube. The work belongs to Postgres: `body ? 'custom'` under the GIN index, paged.
//
// Review fix 11: soft-deleted rows are READ TOO. A value sitting on a soft-deleted row is still
// stored data; hiding it would make the orphan report's promise ("values stay and are
// reportable") quietly false. Each row carries its `deleted` flag so the report can say which.

import { Effect } from "effect"
import { ensureCubeSchema, ensureTable, q, schemaName, withRole } from "./setup.ts"

export type CustomRow = {
  readonly id: string
  readonly custom: Record<string, unknown>
  readonly deleted: boolean
}

/** Page size for the scan: bounded memory per step, few round trips. */
const PAGE = 500

export const customRows = (cube: string, tables: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<CustomRow>> =>
  Effect.promise(async () => {
    const out: Array<CustomRow> = []
    for (const t of tables) {
      await ensureCubeSchema(cube)
      await ensureTable(schemaName(cube), t)
      await withRole(cube, async (c) => {
        for (let offset = 0; ; offset += PAGE) {
          const r = await c.query(
            `SELECT id, body->'custom' AS custom, deleted FROM ${q(schemaName(cube))}.${q(t)}
             WHERE body ? 'custom' ORDER BY created_at ASC LIMIT $1 OFFSET $2`,
            [PAGE, offset],
          )
          for (const row of r.rows as Array<Record<string, unknown>>) {
            const custom = row.custom
            if (typeof custom === "object" && custom !== null && !Array.isArray(custom)) {
              out.push({ id: String(row.id), custom: custom as Record<string, unknown>, deleted: row.deleted === true })
            }
          }
          if (r.rows.length < PAGE) break
        }
      })
    }
    return out
  })
