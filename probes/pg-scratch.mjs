// A throwaway Postgres database for one probe run -- the shared-helper half of the test
// database story (core/src/pg/test-db.ts is the typed twin for unit tests). Created,
// used, dropped WITH (FORCE) so our own connections never block the drop.

import { randomBytes } from "node:crypto"
import pg from "pg"

export const createScratchDatabase = async (label, adminUrl) => {
  const name = `qwbe_probe_${label}_${randomBytes(4).toString("hex")}`
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 })
  await admin.query(`CREATE DATABASE "${name}"`)
  const base = new URL(adminUrl)
  base.pathname = `/${name}`
  return { url: base.toString(), name }
}

export const dropScratchDatabase = async (db, adminUrl) => {
  if (!db) return
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 })
  await admin.query(`DROP DATABASE IF EXISTS "${db.name}" WITH (FORCE)`).catch(() => {})
  await admin.end()
}

export const plantAuthSchema = async (dbUrl) => {
  const c = new pg.Client({ connectionString: dbUrl })
  await c.connect()
  try {
    await c.query(`CREATE SCHEMA "auth"`)
    await c.query(`CREATE TABLE "auth"."sessions" (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, created_at timestamptz NOT NULL,
      deleted BOOLEAN NOT NULL DEFAULT false, version INTEGER NOT NULL DEFAULT 1, body JSONB NOT NULL)`)
  } finally {
    await c.end()
  }
}

export const schemaThere = async (dbUrl, schema) => {
  const c = new pg.Client({ connectionString: dbUrl })
  await c.connect()
  try {
    const r = await c.query(`SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [schema])
    return (r.rowCount ?? 0) > 0
  } finally {
    await c.end()
  }
}
