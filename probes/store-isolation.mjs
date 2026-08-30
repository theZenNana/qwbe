#!/usr/bin/env node

// The isolation ADR-0001 bought with roles, observed from the engine (QWB-44).
//
//   node probes/store-isolation.mjs
//
// Cube A's role asks for cube B's table: Postgres must refuse with a permission error. The
// same statement under cube B's own role must succeed. Nothing in our code performs this
// check -- if the grants are wrong, the isolation is gone and only the engine can say so, so
// the engine is what this probe asks.

import pg from "pg"
import { makeScore } from "./lib.mjs"
import { createScratchDatabase, dropScratchDatabase } from "./pg-scratch.mjs"

const score = makeScore()
const adminUrl = process.env.QWBE_TEST_ADMIN_URL ?? adminUrlFromEnv()
const db = await createScratchDatabase("isolation", adminUrl)
process.env.QWBE_DATABASE_URL = db.url

const { initStore, closeAll } = await import("../core/src/pg/db.ts")
const { ensureCubeSchema, ensureTable } = await import("../core/src/pg/setup.ts")

try {
  await initStore()
  await ensureCubeSchema("cube-a")
  await ensureCubeSchema("cube-b")
  await ensureTable("cube-a", "secrets")
  await ensureTable("cube-b", "notes")
  const client = new pg.Client({ connectionString: db.url })
  await client.connect()

  // Cube A's role: write its own table, then ask for B's.
  await client.query(`BEGIN`)
  await client.query(`SET LOCAL ROLE "qwbe_cube_cube-a"`)
  await client.query(`INSERT INTO "cube-a"."secrets" (id, type, created_at, deleted, version, body)
                      VALUES ('s-1', 'secret', now(), false, 1, '{"hash":"x"}')`)
  score.check("cube A can write its own table through its role", true)

  let refused = ""
  try {
    await client.query(`SELECT * FROM "cube-b"."notes"`)
  } catch (e) {
    refused = e.message
  }
  score.check(
    "cube A's role is refused cube B's table, by the engine",
    /permission denied/.test(refused),
    refused || "no error was raised",
  )
  await client.query(`ROLLBACK`)

  // The same statement under cube B's role succeeds.
  await client.query(`BEGIN`)
  await client.query(`SET LOCAL ROLE "qwbe_cube_cube-b"`)
  await client.query(`INSERT INTO "cube-b"."notes" (id, type, created_at, deleted, version, body)
                      VALUES ('n-1', 'note', now(), false, 1, '{"text":"hi"}')`)
  const read = await client.query(`SELECT id FROM "cube-b"."notes"`)
  score.check("cube B's role can write and read its own table", read.rows.length === 1)
  refused = ""
  try {
    await client.query(`SELECT * FROM "cube-a"."secrets"`)
  } catch (e) {
    refused = e.message
  }
  score.check(
    "cube B's role is refused cube A's table, symmetrically",
    /permission denied/.test(refused),
    refused || "no error was raised",
  )
  await client.query(`ROLLBACK`)
  await client.end()
} finally {
  await closeAll()
  await dropScratchDatabase(db, adminUrl)
}

process.exit(score.report("Store isolation probe - the grants, not the lint, refuse"))

function adminUrlFromEnv() {
  const u = new URL("postgres://localhost/postgres")
  u.hostname = process.env.QWBE_PG_HOST ?? "localhost"
  u.port = process.env.QWBE_PG_PORT ?? "5433"
  u.username = process.env.QWBE_PG_USER ?? "postgres"
  u.password = process.env.QWBE_PG_PASSWORD ?? "qwbe"
  return u.toString()
}
