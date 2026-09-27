// The custom-value ROW READER for the one cube declaring `providesCustomFields`.
//
// The work belongs to Postgres: `body ? 'custom'` under the GIN index, paged -- loading every
// live row of the target cube into memory to filter in JavaScript would scan the whole table
// per form render.
//
// Soft-deleted rows are READ TOO. A value sitting on a soft-deleted row is still
// stored data; hiding it would make the orphan report's promise ("values stay and are
// reportable") quietly false. Each row carries its `deleted` flag so the report can say which.

import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import type { CustomRowView } from "../custom-defs-reader.ts"
import { run } from "./db.ts"
import { ensureCubeSchema, ensureTable, ident, schemaName, withRole } from "./setup.ts"

/** Page size for the scan: bounded memory per step, few round trips. */
const PAGE = 500

type Raw = { readonly id: string; readonly custom: unknown; readonly deleted: boolean }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

export const customRows = (cube: string, tables: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<CustomRowView>> =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const out: Array<CustomRowView> = []
      for (const t of tables) {
        yield* ensureCubeSchema(cube)
        yield* ensureTable(schemaName(cube), t)
        yield* withRole(
          cube,
          Effect.gen(function* () {
            for (let offset = 0; ; offset += PAGE) {
              const rows = yield* sql<Raw>`SELECT id, body->'custom' AS custom, deleted
                                          FROM ${ident(sql, schemaName(cube), t)} WHERE body ? 'custom'
                                          ORDER BY created_at ASC LIMIT ${PAGE} OFFSET ${offset}`
              for (const row of rows) {
                if (isObject(row.custom))
                  out.push({ id: String(row.id), custom: row.custom, deleted: row.deleted === true })
              }
              if (rows.length < PAGE) return
            }
          }),
        )
      }
      return out
    }),
  )

/**
 * ONE row's custom values, read by primary key.
 *
 * The full walk above exists for the ORPHAN report, which genuinely must see every row. A
 * form render asking for one row's values used to ride that same walk -- a paged scan of the
 * whole table per lookup -- and then picked one row in JavaScript. The primary key index
 * answers in one tuple. A row id can sit in any of the cube's tables, so each is probed in
 * order and the scan stops at the first hit.
 */
export const customRowById = (
  cube: string,
  tables: ReadonlyArray<string>,
  id: string,
): Effect.Effect<CustomRowView | undefined> =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      for (const t of tables) {
        yield* ensureCubeSchema(cube)
        yield* ensureTable(schemaName(cube), t)
        const [row] = yield* withRole(
          cube,
          sql<Raw>`SELECT id, body->'custom' AS custom, deleted FROM ${ident(sql, schemaName(cube), t)} WHERE id = ${id}`,
        )
        if (row)
          return { id: String(row.id), custom: isObject(row.custom) ? row.custom : {}, deleted: row.deleted === true }
      }
      return undefined
    }),
  )
