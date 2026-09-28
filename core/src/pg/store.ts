// The CubeStore implementation over Postgres. Six operations, same signatures, error channel
// `never` -- the cubes were written against the SQLite store and NONE of them changes now. A
// driver failure is a defect, exactly as an unexpected SQLite error was: it escapes the Effect
// as a die, not as a failure a cube could "handle". The SqlError is typed everywhere inside
// core/src/pg and turned into that defect in one place, `run` in db.ts.
//
// Two invariants carry over from the old file and are restated here because they are the
// reason this module is shaped the way it is:
//
//   1. A cube asks for a table its manifest did not declare -> ForeignTableError, thrown, not
//      an empty array. The check runs BEFORE any SQL is built, so a computed table name cannot
//      reach the engine.
//   2. Only declared meta columns are interpolated into SQL. Everything else -- field names in
//      `sortBy` and `where` -- is a bound parameter (`body ->> field`), so a field name can
//      never become SQL.
//
// Every operation, read or write, is one transaction that begins with `SET LOCAL ROLE` to the
// cube's role. That transaction is also where isolation lives: Postgres refuses anything the
// role was not granted, and `SET LOCAL` ends with the transaction, so nothing leaks between
// operations on a pooled connection.

import { SqlClient, type SqlError, type Statement } from "@effect/sql"
import { Array as Arr, DateTime, Effect, FiberRef } from "effect"
import { CurrentActor } from "../kernel/actor.ts"
// RowState is declared in the leaf store contract; re-exported here so kernel/store.ts keeps
// its public surface (QWB-70).
import type { CubeStore, RowState, Where } from "../kernel/store-contract.ts"

export type { RowState }

import type { ListWhere, PageRequest } from "../kernel/pagination.ts"
import { type BatchStore, batchFor } from "./batch.ts"
import { run } from "./db.ts"
import { ForeignTableError } from "./errors.ts"
import { activityInsert, decode, diffBody, mergeCustom, newId, orderClause, outboxInsert, whereClause } from "./rows.ts"
import { ensureCubeSchema, ensureTable, ident, schemaName, withRole } from "./setup.ts"

export { ForeignTableError } from "./errors.ts"

/**
 * Echo A1: the capture predicate at the store seam. A row is captured ONLY when its type is
 * EXACTLY the cube's declared entity (insert: the call's entityType; update: the STORED row
 * type). Auxiliary tables -- any other type -- are never captured; undefined capture entity
 * disables capture entirely.
 */
export const capturesType = (captureEntity: string | undefined, type: string): boolean =>
  captureEntity !== undefined && type === captureEntity

/**
 * The row a handler returns IS the response body, and it must equal what was stored: the
 * `body` column is written with JSON.stringify, which drops keys whose value is undefined,
 * while a spread keeps them present-but-undefined. The published row contract reads
 * `custom` as an optional sub-object, so a row carrying `custom: undefined` -- a handler
 * passing "no custom values" the natural way -- fails response encoding. Drop such keys
 * where every row return routes through.
 */
const asStored = <A extends Record<string, unknown>>(row: A): A =>
  Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)) as A

type Row = Record<string, unknown>

/** The lookup statement behind `first`/`where`: live rows, filtered in SQL, oldest first. */
const matchingSql = (sql: SqlClient.SqlClient, t: Statement.Fragment, where: Where, limit: number | undefined) =>
  sql<Row>`SELECT * FROM ${t} WHERE deleted = false ${whereClause(sql, where)} ORDER BY created_at ASC
           ${limit === undefined ? sql.literal("") : sql`LIMIT ${limit}`}`

const decodeRows = <A>(rows: ReadonlyArray<Row>): ReadonlyArray<A> => rows.map(decode) as ReadonlyArray<A>

export const storeFor = (
  cube: string,
  tables: ReadonlyArray<string>,
  /** Fields this cube permits sorting by. Anything else is ignored; the response says so. */
  sortable: ReadonlyArray<string> = [],
  /** The raw SQL batch capability is handed over ONLY on the manifest's declared `usesBatch`. */
  withBatch = false,
  /**
   * Echo A1: record one activity row per committed mutation of rows whose type IS the
   * declared entity, in the SAME transaction. Undefined means no capture. The value comes
   * from `captureEntity(manifest)` (entity-enforcement.ts), so the mediated set and the
   * recorded set cannot drift; auxiliary tables (any other `type`) are never captured.
   */
  captureEntity?: string | undefined,
  /** JSON fields per table that lookups filter on; each gets a `(body ->> field)` index. */
  indexed: Readonly<Record<string, ReadonlyArray<string>>> = {},
): CubeStore & { readonly batch?: BatchStore["batch"] } => {
  const allowed = new Set(tables)
  const sortableFields = new Set(sortable)
  const schema = schemaName(cube)

  /**
   * The path all six operations take: the table check before any SQL exists, the cube's
   * schema and table set up, then one transaction under the cube's role. `f` gets the client
   * and the quoted, schema-qualified table.
   */
  const onTable = <A>(
    table: string,
    f: (sql: SqlClient.SqlClient, t: Statement.Fragment) => Effect.Effect<A, SqlError.SqlError, SqlClient.SqlClient>,
  ): Effect.Effect<A> =>
    run(
      Effect.gen(function* () {
        if (!allowed.has(table)) throw new ForeignTableError(cube, table, tables)
        const sql = yield* SqlClient.SqlClient
        yield* ensureCubeSchema(cube)
        yield* ensureTable(schema, table, indexed[table] ?? [])
        return yield* withRole(cube, f(sql, ident(sql, schema, table)))
      }),
    )

  /** Live rows of `table` matching `where`, oldest first, decoded; at most `limit`. */
  const matching = <A>(table: string, where: Where, limit: number | undefined) =>
    onTable(table, (sql, t) => Effect.map(matchingSql(sql, t, where, limit), decodeRows<A>))

  return {
    first: <A>(table: string, where: Where) => Effect.map(matching<A>(table, where, 1), Arr.head),

    where: <A>(table: string, where: Where, opts?: Parameters<CubeStore["where"]>[2]) =>
      matching<A>(table, where, opts?.limit),

    all: <A>(table: string) =>
      onTable(table, (sql, t) =>
        Effect.map(
          sql<Row>`SELECT * FROM ${t} WHERE deleted = false ORDER BY created_at ASC`,
          (rows) => rows.map(decode) as ReadonlyArray<A>,
        ),
      ),

    page: <A>(
      table: string,
      page: PageRequest,
      where?: { readonly field: string; readonly value: string } | ListWhere,
    ) =>
      onTable(table, (sql, t) =>
        Effect.gen(function* () {
          const w = whereClause(sql, where)
          const o = orderClause(sql, page.sortBy, page.descending ?? false, sortableFields)
          const [count] = yield* sql<{ c: number }>`SELECT COUNT(*)::int AS c FROM ${t} WHERE deleted = false ${w}`
          const rows = yield* sql<Row>`SELECT * FROM ${t} WHERE deleted = false ${w} ${o.sql}
                                       LIMIT ${page.limit} OFFSET ${page.offset}`
          return {
            rows: rows.map(decode) as ReadonlyArray<A>,
            total: count?.c ?? 0,
            offset: page.offset,
            limit: page.limit,
            sortedBy: o.applied,
          }
        }),
      ),

    byId: <A>(table: string, id: string) =>
      onTable(table, (sql, t) =>
        Effect.map(sql<Row>`SELECT * FROM ${t} WHERE id = ${id} AND deleted = false`, ([row]) =>
          row ? (decode(row) as A) : undefined,
        ),
      ),

    insert: (table: string, entityType: string, prefix: string, values: Record<string, unknown>) =>
      onTable(table, (sql, t) =>
        Effect.gen(function* () {
          // A FiberRef read needs no Effect requirement, so the store keeps `R = never` (a cube
          // could not provide a service it cannot see).
          const actor = yield* FiberRef.get(CurrentActor)
          const row = asStored({
            id: newId(prefix),
            type: entityType,
            createdAt: DateTime.formatIso(yield* DateTime.now),
            deleted: false,
            ...values,
          })
          const { id, type, createdAt, deleted, ...body } = row
          yield* sql`INSERT INTO ${t} (id, type, created_at, deleted, version, body)
                     VALUES (${id}, ${type}, ${createdAt}::timestamptz, ${deleted}, 1, ${JSON.stringify(body)})`
          yield* outboxInsert(sql, cube, table, id, "insert", 1)
          if (capturesType(captureEntity, entityType)) {
            yield* activityInsert(sql, cube, entityType, id, "create", 1, actor, diffBody(null, body))
          }
          return row
        }),
      ),

    update: (table: string, id: string, patch: Record<string, unknown>) =>
      onTable(table, (sql, t) =>
        Effect.gen(function* () {
          const actor = yield* FiberRef.get(CurrentActor)
          const [current] = yield* sql<Row>`SELECT * FROM ${t} WHERE id = ${id}`
          if (!current) return undefined
          const previous = decode(current)
          // `custom` merges (rows.ts), so a partial PATCH cannot wipe sibling values.
          const withCustom = mergeCustom(current, { ...previous, ...patch })
          const { id: _i, type, createdAt, deleted, ...body } = withCustom
          const version = ((current as { version?: number }).version ?? 1) + 1
          yield* sql`UPDATE ${t}
                     SET type = ${String(type)}, created_at = ${String(createdAt)}::timestamptz, deleted = ${deleted},
                         version = ${version}, body = ${JSON.stringify(body)}
                     WHERE id = ${id}`
          // ADR-0001 section 5 lists delete as its own op: a soft delete is not an update.
          const op = deleted === true ? "delete" : "update"
          yield* outboxInsert(sql, cube, table, id, op, version)
          if (capturesType(captureEntity, String(type))) {
            const { id: _pi, type: _pt, createdAt: _pc, deleted: _pd, ...prevBody } = previous
            const changes = deleted === true ? {} : diffBody(prevBody, body)
            yield* activityInsert(sql, cube, String(type), id, op, version, actor, changes)
          }
          // The row stores the MERGE, so the response must too -- a
          // PATCH response reporting `custom` as only the patched keys would lie about the row.
          return asStored({ ...withCustom, id })
        }),
      ),

    ...(withBatch ? { batch: batchFor(cube) } : {}),

    count: (table: string) =>
      onTable(table, (sql, t) =>
        Effect.map(sql<{ c: number }>`SELECT COUNT(*)::int AS c FROM ${t} WHERE deleted = false`, ([r]) => r?.c ?? 0),
      ),
  }
}

/**
 * Echo A3: the row STATE of one captured entity row -- `{ id, type, deleted }` and nothing
 * else, no body column ever selected -- read under the owning cube's OWN role over its OWN
 * declared tables. Kernel-only: it is built next to `storeFor` and handed to the registry
 * (`RegistryEntry.state`), never to a cube. Undefined when no declared table holds a row of
 * that id whose stored type IS the capture entity (auxiliary rows are invisible here, as they
 * are to activity capture). This is the ONE current-state source the echo feed may use to
 * tell "deleted" from "missing": the activity log is history, never truth.
 */
export const rowStateFor =
  (cube: string, tables: ReadonlyArray<string>, captureEntity: string) =>
  (id: string): Effect.Effect<RowState | undefined, never, never> =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const schema = yield* ensureCubeSchema(cube)
        for (const t of tables) yield* ensureTable(schema, t)
        return yield* withRole(
          cube,
          Effect.gen(function* () {
            for (const t of tables) {
              const [row] = yield* sql<RowState>`SELECT id, type, deleted FROM ${ident(sql, schema, t)}
                                                 WHERE id = ${id} AND type = ${captureEntity}`
              if (row) return { id: row.id, type: row.type, deleted: row.deleted === true }
            }
            return undefined
          }),
        )
      }),
    )
