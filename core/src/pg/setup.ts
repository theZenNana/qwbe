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
// Postgres with a permission error. See probes/store-isolation.mjs, which proves both halves.

import { MAX_CUSTOM_BYTES, MAX_CUSTOM_KEYS } from "../custom-values.ts"
import { getPool, type Pool } from "./db.ts"

/** The same identifier `storeFileName` produced for the file, without the extension. */
export const schemaName = (cube: string): string => cube.replace(/\//g, "--")

/** Every identifier in this module is quoted, always. Identifiers are never parameters. */
export const q = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`

export const roleName = (schema: string): string => `qwbe_cube_${schema}`

/**
 * Schemas already set up in this process -- DDL runs once per cube, not per query. The value
 * is the IN-FLIGHT promise, not a completed flag: two concurrent first touches of the same
 * cube must not both run the DDL block (Postgres refuses the race with a duplicate-namespace
 * error, and an `Effect.promise` turns that into a 500 on the first burst of traffic). The
 * map entry is replaced by a resolved promise when the DDL commits, so a failed setup is
 * retried on the next call instead of being cached forever.
 */
const ensuredSchemas = new Map<string, Promise<string>>()

/**
 * Create the schema and its role if either is missing, then grant. Idempotent: boot and first
 * use both land here, and `IF NOT EXISTS` keeps the second call a no-op. The role is NOLOGIN --
 * nobody authenticates as a cube; the application role sets itself to the cube's role per
 * transaction, and membership is granted so that `SET ROLE` is allowed at all.
 *
 * Concurrency: the whole block runs on ONE client, inside one transaction that first takes a
 * transaction-scoped advisory lock keyed on the schema name. Two processes racing to set up
 * the same cube serialize on the lock; the loser then sees the winner's schema and role and
 * its DDL statements are all no-ops. Combined with the in-flight-promise memoization above,
 * neither one process's burst nor two processes' boot can double-run the DDL.
 */
export const ensureCubeSchema = async (cube: string): Promise<string> => {
  const schema = schemaName(cube)
  const inflight = ensuredSchemas.get(schema)
  if (inflight) return inflight
  const run = (async () => {
    const p = getPool()
    const role = roleName(schema)
    const client = await p.connect()
    let failed = false
    try {
      await client.query("BEGIN")
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [schema])
      // A SECOND, global lock around the role DDL: `tuple concurrently updated` is what two
      // transactions updating pg_roles at the same moment get, and the schema-keyed lock does
      // not prevent that -- two DIFFERENT cubes booting concurrently both reach CREATE ROLE.
      // The customfields snapshot load runs at boot, racing the other
      // cubes' first touch. One lock key serializes every role creation; ordering (schema
      // lock, then this one) is the same everywhere, so no deadlock.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ["qwbe/role-ddl"])
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${q(schema)}`)
      const roleExists = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role])
      if ((roleExists.rowCount ?? 0) === 0) await client.query(`CREATE ROLE ${q(role)} NOLOGIN`)
      // The grant target is the login that owns THIS session -- taken from current_user, not
      // from pool options, which are undefined when the pool was built from a connection
      // string (and defaulting to "postgres" would grant every cube role to the wrong login).
      const me = await client.query(`SELECT current_user AS u`)
      const appUser = String((me.rows[0] as { u: string }).u)
      await client.query(`GRANT ${q(role)} TO ${q(appUser)}`)
      await client.query(`REVOKE ALL ON SCHEMA ${q(schema)} FROM PUBLIC`)
      await client.query(`GRANT USAGE ON SCHEMA ${q(schema)} TO ${q(role)}`)
      // ALL TABLES covers tables that already exist (a renamed-in schema, a migrated import);
      // DEFAULT PRIVILEGES covers the ones ensureTable creates afterwards.
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${q(schema)} TO ${q(role)}`)
      await client.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${q(schema)} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${q(role)}`,
      )
      await client.query(`GRANT USAGE ON SCHEMA qwbe TO ${q(role)}`)
      await client.query(`GRANT INSERT ON qwbe.outbox TO ${q(role)}`)
      // bigserial draws from a sequence; INSERT on the table alone does not cover it.
      await client.query(`GRANT USAGE ON SEQUENCE qwbe.outbox_id_seq TO ${q(role)}`)
      await client.query("COMMIT")
    } catch (e) {
      failed = true
      await client.query("ROLLBACK").catch(() => {})
      // The error goes to release() so pg DESTROYS the client: one whose rollback did not
      // take must never rejoin the pool still inside a transaction -- the next checkout
      // would inherit it.
      if (e instanceof Error) client.release(e)
      throw e
    } finally {
      if (!failed) client.release()
    }
    return schema
  })()
  ensuredSchemas.set(schema, run)
  try {
    return await run
  } catch (e) {
    ensuredSchemas.delete(schema)
    throw e
  }
}

/** The one row shape, created on first touch of a table -- the cube writes no migrations yet. */
/** Created once per process: DDL under concurrency is lock churn for no information. Same
 * in-flight-promise memoization as ensureCubeSchema -- two first touches of one table must
 * not race the CREATE TABLE either. */
const ensuredTables = new Map<string, Promise<void>>()

export const ensureTable = async (schema: string, table: string): Promise<void> => {
  const key = `${schema}.${table}`
  const inflight = ensuredTables.get(key)
  if (inflight) return inflight
  const run = (async () => {
    const p = getPool()
    const client = await p.connect()
    let failed = false
    try {
      await client.query("BEGIN")
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [key])
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${q(schema)}.${q(table)} (
           id text PRIMARY KEY,
           type text NOT NULL,
           created_at timestamptz NOT NULL,
           deleted boolean NOT NULL DEFAULT false,
           version integer NOT NULL DEFAULT 1,
           body jsonb NOT NULL
         )`,
      )
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${q(`${table}_body_gin`)} ON ${q(schema)}.${q(table)} USING GIN (body)`,
      )
      await ensureCustomCaps(client as unknown as Pool, schema, table)
      await client.query("COMMIT")
    } catch (e) {
      failed = true
      await client.query("ROLLBACK").catch(() => {})
      if (e instanceof Error) client.release(e)
      throw e
    } finally {
      if (!failed) client.release()
    }
  })()
  ensuredTables.set(key, run)
  try {
    return await run
  } catch (e) {
    ensuredTables.delete(key)
    throw e
  }
}

/** Does the schema exist? The data-migration checks ask this instead of looking at files. */
export const schemaExists = async (schema: string): Promise<boolean> => {
  const r = await getPool().query(`SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [schema])
  return (r.rowCount ?? 0) > 0
}

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
const ensureCustomCaps = async (client: Pool, schema: string, table: string): Promise<void> => {
  const name = `${table}_custom_caps`
  const exists = await client.query(`SELECT 1 FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass`, [
    name,
    `${q(schema)}.${q(table)}`,
  ])
  if ((exists.rowCount ?? 0) === 0) {
    await client.query(`ALTER TABLE ${q(schema)}.${q(table)} ADD CONSTRAINT ${q(name)} ${customCapsCheck()}`)
  }
}

/**
 * One client, one transaction, the cube's role. Everything the store does goes through here,
 * so "every operation runs under the cube's role inside a transaction" is enforced in exactly
 * one place rather than remembered in six.
 *
 * Exported for the transaction test: the rollback guarantee is exactly this function's
 * catch branch, and the test drives it directly rather than duplicating its SQL.
 */
export const withRole = async <T>(cube: string, fn: (client: Pool) => Promise<T>): Promise<T> => {
  const schema = await ensureCubeSchema(cube)
  const p = getPool()
  const client = await p.connect()
  let failed = false
  try {
    await client.query("BEGIN")
    await client.query(`SET LOCAL ROLE ${q(roleName(schema))}`)
    const result = await fn(client as unknown as Pool)
    await client.query("COMMIT")
    return result
  } catch (e) {
    failed = true
    await client.query("ROLLBACK").catch(() => {})
    // The error goes to release() so pg destroys the client instead of reusing it: a
    // connection whose rollback did not take must not rejoin the pool with the cube's
    // `SET LOCAL ROLE` still in force for whoever checks it out next.
    client.release(e as Error)
    throw e
  } finally {
    if (!failed) client.release()
  }
}
