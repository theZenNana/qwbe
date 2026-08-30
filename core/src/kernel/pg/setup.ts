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

import { getPool } from "./db.ts"

/** The same identifier `storeFileName` produced for the file, without the extension. */
export const schemaName = (cube: string): string => cube.replace(/\//g, "--")

/** Every identifier in this module is quoted, always. Identifiers are never parameters. */
export const q = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`

export const roleName = (schema: string): string => `qwbe_cube_${schema}`

/** Schemas and tables already set up in this process -- DDL runs once per cube, not per query. */
const ensuredSchemas = new Set<string>()

/**
 * Create the schema and its role if either is missing, then grant. Idempotent: boot and first
 * use both land here, and `IF NOT EXISTS` keeps the second call a no-op. The role is NOLOGIN --
 * nobody authenticates as a cube; the application role sets itself to the cube's role per
 * transaction, and membership is granted so that `SET ROLE` is allowed at all.
 */
export const ensureCubeSchema = async (cube: string): Promise<string> => {
  const schema = schemaName(cube)
  if (ensuredSchemas.has(schema)) return schema
  const p = getPool()
  const role = roleName(schema)
  await p.query(`CREATE SCHEMA IF NOT EXISTS ${q(schema)}`)
  await p.query(`DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
         CREATE ROLE ${q(role)} NOLOGIN;
       END IF;
     END $$;`)
  const appUser = p.options.user ?? "postgres"
  await p.query(`GRANT ${q(role)} TO ${q(appUser)}`)
  await p.query(`REVOKE ALL ON SCHEMA ${q(schema)} FROM PUBLIC`)
  await p.query(`GRANT USAGE ON SCHEMA ${q(schema)} TO ${q(role)}`)
  await p.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${q(schema)} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${q(role)}`,
  )
  await p.query(`GRANT INSERT ON qwbe.outbox TO ${q(role)}`)
  ensuredSchemas.add(schema)
  return schema
}

/** The kernel forgets its setup cache -- used by tests that create and drop databases. */
export const forgetEnsured = (): void => {
  ensuredSchemas.clear()
}

/** The one row shape, created on first touch of a table -- the cube writes no migrations yet. */
export const ensureTable = async (schema: string, table: string): Promise<void> => {
  const p = getPool()
  await p.query(
    `CREATE TABLE IF NOT EXISTS ${q(schema)}.${q(table)} (
       id text PRIMARY KEY,
       type text NOT NULL,
       created_at timestamptz NOT NULL,
       deleted boolean NOT NULL DEFAULT false,
       version integer NOT NULL DEFAULT 1,
       body jsonb NOT NULL
     )`,
  )
  await p.query(`CREATE INDEX IF NOT EXISTS ${q(`${table}_body_gin`)} ON ${q(schema)}.${q(table)} USING GIN (body)`)
}

/** Does the schema exist? The data-migration checks ask this instead of looking at files. */
export const schemaExists = async (schema: string): Promise<boolean> => {
  const r = await getPool().query(`SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [schema])
  return (r.rowCount ?? 0) > 0
}
