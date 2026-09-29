// Per-cube setup: one schema, one NOLOGIN role, grants as tight as they can be.
//
// The schema name reuses the mapping the SQLite file name used (`storeFileName` minus its
// extension), so a cube's data keeps the same identifier across the migration -- `crm/contacts`
// was `crm--contacts.sqlite` and is now the schema `"crm--contacts"`, and the SQLite-to-Postgres
// tool can map old to new without a second spelling of the rule.
//
// The role is the isolation. `qwbe_cube_<schema>` can USE its own schema and touch its own
// tables and insert into the kernel outbox, and that is EVERYTHING. The application connects
// as the URL's user, which is a member of every cube role, and each operation opens its
// transaction with `SET LOCAL ROLE` -- so a cube's query against another cube's schema dies in
// Postgres with a permission error. See checks/integration/pg-grants.test.ts.

import { SqlClient, type SqlError, type Statement } from "@effect/sql"
import { Cache, Context, Data, Duration, Effect, Exit, Layer } from "effect"
import { MAX_CUSTOM_BYTES, MAX_CUSTOM_KEYS } from "../custom-values.ts"
import { SORT_KEYS, sortKeysFor } from "../kernel/sort-key.ts"

/** The same identifier `storeFileName` produced for the file, without the extension. */
export const schemaName = (cube: string): string => cube.replace(/\//g, "--")

/** Every identifier in this module is quoted, always. Identifiers are never parameters. */
export const q = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`

/**
 * An identifier as a SQL fragment. Not the client's `sql(name)`: its escaping splits on dots,
 * so a declared table named `a.b` would become the qualified name `"a"."b"`. `q` keeps every
 * name one identifier, exactly as before the move to @effect/sql.
 */
export const ident = (sql: Statement.Constructor, ...parts: ReadonlyArray<string>): Statement.Fragment =>
  sql.literal(parts.map(q).join("."))

export const roleName = (schema: string): string => `qwbe_cube_${schema}`

/**
 * The per-process setup memo, owned by the pool's layer: DDL runs once per cube (and per
 * table), not per query. Each entry holds the IN-FLIGHT lookup, so two concurrent first
 * touches of the same cube share one DDL run (Postgres refuses the race with a
 * duplicate-namespace error). A failed lookup expires at once, so it is retried on the next
 * call instead of being cached forever.
 */
export class Setup extends Context.Tag("qwbe/pg/Setup")<
  Setup,
  {
    readonly schema: (schema: string) => Effect.Effect<string, SqlError.SqlError>
    readonly table: (schema: string, table: string) => Effect.Effect<void, SqlError.SqlError>
    readonly index: (schema: string, table: string, field: string) => Effect.Effect<void, SqlError.SqlError>
    /** The boot backfill of sort keys, once per process per table and field list. */
    readonly sortKeys: (
      schema: string,
      table: string,
      fields: ReadonlyArray<string>,
    ) => Effect.Effect<void, SqlError.SqlError>
    readonly activityReader: (schema: string) => Effect.Effect<void, SqlError.SqlError>
  }
>() {}

const memo = <K, A>(lookup: (key: K) => Effect.Effect<A, SqlError.SqlError>) =>
  Cache.makeWith({
    capacity: Number.MAX_SAFE_INTEGER,
    lookup,
    timeToLive: Exit.match({ onFailure: () => Duration.zero, onSuccess: () => Duration.infinity }),
  }).pipe(Effect.map((cache) => (key: K) => cache.get(key)))

/**
 * Create the schema and its role if either is missing, then grant. Idempotent: boot and first
 * use both land here, and `IF NOT EXISTS` keeps the second call a no-op. The role is NOLOGIN --
 * nobody authenticates as a cube; the application role sets itself to the cube's role per
 * transaction, and membership is granted so that `SET ROLE` is allowed at all.
 *
 * Concurrency: the whole block runs inside one transaction that first takes a
 * transaction-scoped advisory lock keyed on the schema name. Two processes racing to set up
 * the same cube serialize on the lock; the loser then sees the winner's schema and role and
 * its DDL statements are all no-ops. Combined with the in-flight memo above, neither one
 * process's burst nor two processes' boot can double-run the DDL.
 */
const createSchema = (sql: SqlClient.SqlClient, schema: string) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const role = roleName(schema)
      const s = ident(sql, schema)
      const r = ident(sql, role)
      yield* sql`SELECT pg_advisory_xact_lock(hashtext(${schema}))`
      // A SECOND, global lock around the role DDL: `tuple concurrently updated` is what two
      // transactions updating pg_roles at the same moment get, and the schema-keyed lock does
      // not prevent that -- two DIFFERENT cubes booting concurrently both reach CREATE ROLE.
      // The customfields snapshot load runs at boot, racing the other
      // cubes' first touch. One lock key serializes every role creation; ordering (schema
      // lock, then this one) is the same everywhere, so no deadlock.
      yield* sql`SELECT pg_advisory_xact_lock(hashtext(${"qwbe/role-ddl"}))`
      yield* sql`CREATE SCHEMA IF NOT EXISTS ${s}`
      const roleExists = yield* sql`SELECT 1 FROM pg_roles WHERE rolname = ${role}`
      if (roleExists.length === 0) yield* sql`CREATE ROLE ${r} NOLOGIN`
      // The grant target is the login that owns THIS session -- taken from current_user, not
      // from pool options, which are undefined when the pool was built from a connection
      // string (and defaulting to "postgres" would grant every cube role to the wrong login).
      const [me] = yield* sql<{ u: string }>`SELECT current_user AS u`
      yield* sql`GRANT ${r} TO ${ident(sql, String(me?.u))}`
      yield* sql`REVOKE ALL ON SCHEMA ${s} FROM PUBLIC`
      yield* sql`GRANT USAGE ON SCHEMA ${s} TO ${r}`
      // ALL TABLES covers tables that already exist (a renamed-in schema, a migrated import);
      // DEFAULT PRIVILEGES covers the ones ensureTable creates afterwards.
      yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${s} TO ${r}`
      yield* sql`ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${r}`
      yield* sql`GRANT USAGE ON SCHEMA qwbe TO ${r}`
      yield* sql`GRANT INSERT ON qwbe.outbox TO ${r}`
      // bigserial draws from a sequence; INSERT on the table alone does not cover it.
      yield* sql`GRANT USAGE ON SEQUENCE qwbe.outbox_id_seq TO ${r}`
      // Echo A1: every cube role records activity for its committed row mutations; SELECT
      // stays off -- only the one role whose cube declares `readsActivity` reads the log
      // (activityReader below, granted lazily by the activity tools).
      yield* sql`GRANT INSERT ON qwbe.activity TO ${r}`
      yield* sql`GRANT USAGE ON SEQUENCE qwbe.activity_id_seq TO ${r}`
      return schema
    }),
  )

/** The one row shape, created on first touch of a table -- the cube writes no migrations yet. */
const createTable = (sql: SqlClient.SqlClient, schema: string, table: string) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const t = ident(sql, schema, table)
      yield* sql`SELECT pg_advisory_xact_lock(hashtext(${`${schema}.${table}`}))`
      yield* sql`CREATE TABLE IF NOT EXISTS ${t} (
           id text PRIMARY KEY,
           type text NOT NULL,
           created_at timestamptz NOT NULL,
           deleted boolean NOT NULL DEFAULT false,
           version integer NOT NULL DEFAULT 1,
           body jsonb NOT NULL
         )`
      yield* sql`CREATE INDEX IF NOT EXISTS ${ident(sql, `${table}_body_gin`)} ON ${t} USING GIN (body)`
      yield* ensureCustomCaps(sql, schema, table)
    }),
  )

/**
 * DDL takes no bound parameters, so a lookup field becomes SQL text only as a plain identifier
 * that fits Postgres's 63-byte name limit. Manifest validation refuses anything else at mount.
 */
export const isLookupField = (field: string): boolean => /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(field)

/**
 * The expression index behind a declared lookup field (`body ->> field`). A field outside
 * `isLookupField` throws, and the store turns that into a defect before any DDL runs.
 */
export const lookupIndexSql = (schema: string, table: string, field: string): string => {
  if (!isLookupField(field)) throw new Error(`lookup index field refused: ${JSON.stringify(field)}`)
  return `CREATE INDEX IF NOT EXISTS ${q(`${table}_${field}_idx`)} ON ${q(schema)}.${q(table)}
          ((body ->> '${field}')) WHERE deleted = false`
}

export const SetupLive = Layer.effect(
  Setup,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const schema = yield* memo((s: string) => createSchema(sql, s))
    const table = yield* memo(([s, t]: readonly [string, string]) => createTable(sql, s, t))
    // suspend: a refused field throws inside the effect, so it is a defect, not a throw at build.
    // The memo only covers this process: two sessions racing on CREATE INDEX IF NOT EXISTS
    // collide on pg_class, so the DDL waits on the table's advisory lock, like createTable.
    const index = yield* memo(([s, t, f]: readonly [string, string, string]) =>
      Effect.suspend(() => {
        const ddl = lookupIndexSql(s, t, f)
        return sql.withTransaction(
          Effect.zipRight(sql`SELECT pg_advisory_xact_lock(hashtext(${`${s}.${t}`}))`, sql.unsafe(ddl)),
        )
      }),
    )
    // Runs as the login, outside any cube transaction: each chunk commits on its own.
    const sortKeys = yield* memo(([s, t, fields]: readonly [string, string, string]) =>
      rekey(sql, ident(sql, s, t), JSON.parse(fields) as ReadonlyArray<string>),
    )
    // Grant SELECT on `qwbe.activity` to exactly one cube role: the one whose manifest declares
    // `readsActivity` (at-most-one checked at mount). Lazy because `mount` is synchronous and
    // cube roles come into being lazily; idempotent like every GRANT.
    const activityReader = yield* memo((s: string) =>
      Effect.gen(function* () {
        // The reader's role exists only once the schema setup has run for it: on a fresh
        // database the GRANT below would otherwise hit `role "..." does not exist`.
        yield* schema(s)
        const r = ident(sql, roleName(s))
        yield* sql`GRANT SELECT ON qwbe.activity TO ${r}`
        // Echo A2 comments: the reader role is the ONLY role that may touch qwbe.comment (the
        // comment write path runs under it, same-transaction with its activity row). Batch and
        // every other cube role stay exactly as wide as A1 left them.
        yield* sql`GRANT SELECT, INSERT, UPDATE ON qwbe.comment TO ${r}`
      }),
    )
    return {
      schema,
      table: (s, t) => table(Data.tuple(s, t)),
      index: (s, t, f) => index(Data.tuple(s, t, f)),
      sortKeys: (s, t, fields) => sortKeys(Data.tuple(s, t, JSON.stringify(fields))),
      activityReader,
    }
  }),
)

export const ensureCubeSchema = (cube: string) => Effect.flatMap(Setup, (s) => s.schema(schemaName(cube)))

/**
 * The table, then one expression index per declared lookup field (each memoized on its own),
 * then the sort-key backfill for the cube's sortable fields.
 */
export const ensureTable = (
  schema: string,
  table: string,
  indexed: ReadonlyArray<string> = [],
  sortable: ReadonlyArray<string> = [],
) =>
  Effect.flatMap(Setup, (s) =>
    Effect.all(
      [
        s.table(schema, table),
        Effect.forEach(indexed, (f) => s.index(schema, table, f), { discard: true }),
        sortable.length === 0 ? Effect.void : s.sortKeys(schema, table, sortable),
      ],
      { discard: true },
    ),
  )

const REKEY_CHUNK = 500

/** Key order does not matter: jsonb hands objects back with its own key order. */
const canonical = (value: unknown): string =>
  JSON.stringify(value ?? null, (_k, v: unknown) =>
    typeof v === "object" && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v,
  )

/**
 * Rewrite `_sort` on every row of `t` whose stored keys differ from what `fields` give today:
 * missing, an older SORT_KEY_VERSION, or stale after a raw batch changed a field. Idempotent:
 * a second run finds nothing to write. Rows are walked by id in chunks, and only rows carrying
 * a sortable field or a `_sort` are read (the GIN index answers `?|`). A row changed between
 * the read and the write keeps its body: the UPDATE matches the hash of the body it keyed.
 * Keys are derived data: no version bump, no outbox, no activity. With `ids`, only those rows
 * are looked at (a batch re-keys what it wrote, not the table).
 */
export const rekey = (
  sql: SqlClient.SqlClient,
  t: Statement.Fragment,
  fields: ReadonlyArray<string>,
  ids?: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    if (fields.length === 0 || ids?.length === 0) return
    const probe = [...fields, SORT_KEYS]
    const only = ids === undefined ? sql`` : sql`AND id = ANY(${ids}::text[])`
    let after = ""
    for (;;) {
      const rows = yield* sql<{ id: string; body: Record<string, unknown>; h: string }>`
        SELECT id, body, md5((body - '_sort')::text) AS h FROM ${t}
        WHERE body ?| ${probe}::text[] ${only} AND id COLLATE "C" > ${after} ORDER BY id COLLATE "C" LIMIT ${REKEY_CHUNK}`
      const stale = rows.flatMap((r) => {
        const k = sortKeysFor(r.body, fields) ?? null
        return canonical(k) === canonical(r.body[SORT_KEYS]) ? [] : [{ id: r.id, h: r.h, k }]
      })
      if (stale.length > 0) {
        yield* sql`UPDATE ${t} AS r
                   SET body = CASE WHEN u.k IS NULL THEN r.body - '_sort' ELSE jsonb_set(r.body, '{_sort}', u.k) END
                   FROM jsonb_to_recordset(${JSON.stringify(stale)}::jsonb) AS u(id text, h text, k jsonb)
                   WHERE r.id = u.id AND md5((r.body - '_sort')::text) = u.h`
      }
      const last = rows.at(-1)
      if (rows.length < REKEY_CHUNK || !last) return
      after = last.id
    }
  })

export const ensureActivityReader = (cube: string) => Effect.flatMap(Setup, (s) => s.activityReader(schemaName(cube)))

/** Does the schema exist? The data-migration checks ask this instead of looking at files. */
export const schemaExists = (schema: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(sql`SELECT 1 FROM information_schema.schemata WHERE schema_name = ${schema}`, (r) => r.length > 0),
  )

/*
 * The custom-value caps as a DATABASE constraint. The app checks
 * the caps on every write; this CHECK holds in Postgres even without the application.
 *
 * The key count is exact (0002-custom-caps.sql gives the CHECK its helper function). The byte
 * cap is the encoding-safe upper bound of the app cap: the app measures JSON.stringify code
 * units (MAX_CUSTOM_BYTES), a jsonb text rendering costs up to 4 UTF-8 bytes per code unit and
 * adds one space per key and per comma. Anything the app accepted fits under this number, so
 * the constraint can never reject a write the app let through, and nothing meaningfully larger
 * gets in either.
 */
const customCapsCheck = (): string => {
  const byteCap = MAX_CUSTOM_BYTES * 4 + MAX_CUSTOM_KEYS * 2 + 8
  return `CHECK (jsonb_typeof(body -> 'custom') <> 'object' OR (
                 qwbe.custom_key_count(body -> 'custom') <= ${MAX_CUSTOM_KEYS} AND
                 octet_length((body -> 'custom')::text) <= ${byteCap}))`
}

/**
 * Add the custom-caps CHECK if the table does not have it yet. Idempotent: tables without it
 * get the constraint on the next boot, and the lookups above run once per
 * process per table.
 */
const ensureCustomCaps = (sql: SqlClient.SqlClient, schema: string, table: string) =>
  Effect.gen(function* () {
    const name = `${table}_custom_caps`
    const exists =
      yield* sql`SELECT 1 FROM pg_constraint WHERE conname = ${name} AND conrelid = ${`${q(schema)}.${q(table)}`}::regclass`
    if (exists.length === 0) {
      yield* sql`ALTER TABLE ${ident(sql, schema, table)} ADD CONSTRAINT ${ident(sql, name)} ${sql.literal(customCapsCheck())}`
    }
  })

/**
 * One transaction, the cube's role. Everything the store does goes through here, so "every
 * operation runs under the cube's role inside a transaction" is enforced in exactly one place
 * rather than remembered in six. `sql.withTransaction` rolls back on any failure or defect, and
 * `SET LOCAL` ends with the transaction, so nothing leaks to the next checkout of the connection.
 */
export const withRole = <A, E, R>(cube: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const schema = yield* ensureCubeSchema(cube)
    return yield* sql.withTransaction(Effect.zipRight(sql`SET LOCAL ROLE ${ident(sql, roleName(schema))}`, effect))
  })
