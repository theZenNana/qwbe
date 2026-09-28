// The seed SQL of the API benchmark: one statement clones a template row `rows` times with generate_series.
import * as Schema from "effect/Schema"
import type { Seed } from "../shared/config.ts"

// The column list as information_schema answers it, decoded where it enters.
export const Columns = Schema.Array(Schema.Struct({ name: Schema.String, hasDefault: Schema.Boolean }))

export type Column = (typeof Columns.Type)[number]

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`
const quoteText = (text: string) => `'${text.replaceAll("'", "''")}'`

/** `schema.table` quoted, e.g. crm--contacts.contacts -> "crm--contacts"."contacts". */
export const tableIdent = (table: string) => table.split(".").map(quoteIdent).join(".")

/** The columns of `schema.table` in order, each flagged when it has a default. */
export const columnsSql = (table: string) => {
  const [schema = "", name = ""] = table.split(".")
  return (
    `SELECT column_name AS name, column_default IS NOT NULL AS "hasDefault" FROM information_schema.columns ` +
    `WHERE table_schema = ${quoteText(schema)} AND table_name = ${quoteText(name)} ORDER BY ordinal_position`
  )
}

const BENCH_ID = "%-bench%"

// The template is a row a request created, never an earlier clone.
const template = (table: string) =>
  `SELECT * FROM ${tableIdent(table)} WHERE id::text NOT LIKE ${quoteText(BENCH_ID)} ORDER BY id LIMIT 1`

// Unpadded, so a fixture can name row `{n}` of the seed.
const newId = (seed: typeof Seed.Type) => {
  const prefix = seed.prefix === undefined ? "split_part(t.id::text, '-', 1)" : quoteText(seed.prefix)
  return `${prefix} || '-bench' || g`
}

const TIMES = new Set(["created_at", "at"])

const columnValue = (column: Column, seed: typeof Seed.Type, names: ReadonlySet<string>) => {
  const col = `t.${quoteIdent(column.name)}`
  if (column.name === "id") return newId(seed)
  if (TIMES.has(column.name)) return `${col} - g * interval '1 second'`
  if (seed.vary === undefined) return col
  if (column.name === seed.vary) return `${col} || ' ' || g`
  if (column.name === "body" && !names.has(seed.vary)) {
    const key = quoteText(seed.vary)
    return `jsonb_set(${col}, ${quoteText(`{${seed.vary}}`)}, to_jsonb(coalesce(${col}->>${key}, '') || ' ' || g))`
  }
  return col
}

/** Clones the template row of `seed.table` `rows` times; a column with a default (a serial id) is left to it. */
export const cloneSql = (seed: typeof Seed.Type, columns: ReadonlyArray<Column>, rows: number) => {
  const names = new Set(columns.map(({ name }) => name))
  const written = columns.filter(({ hasDefault, name }) => !(hasDefault && name === "id"))
  return (
    `INSERT INTO ${tableIdent(seed.table)} (${written.map(({ name }) => quoteIdent(name)).join(", ")}) ` +
    `SELECT ${written.map((column) => columnValue(column, seed, names)).join(", ")} ` +
    `FROM (${template(seed.table)}) t, generate_series(1, ${rows}) g`
  )
}

const OWNERSHIP = "permissions.permission_ownership"

/** Gives each clone the owner of its template, so row visibility treats clones like the original. */
export const ownershipSql = (seed: typeof Seed.Type) =>
  `INSERT INTO ${tableIdent(OWNERSHIP)} (id, type, created_at, deleted, version, body) ` +
  `SELECT 'own-' || e.id, o.type, o.created_at, o.deleted, o.version, jsonb_set(o.body, '{entityId}', to_jsonb(e.id)) ` +
  `FROM ${tableIdent(OWNERSHIP)} o, ${tableIdent(seed.table)} e ` +
  `WHERE o.body->>'entityId' = (SELECT id::text FROM (${template(seed.table)}) t) AND e.id::text LIKE ${quoteText(BENCH_ID)}`
