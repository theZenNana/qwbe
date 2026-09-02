#!/usr/bin/env node

// The SQLite-to-Postgres migration tool, observed doing its whole job.
//
//   node probes/store-migration.mjs
//
// Builds a small SQLite file in the OLD layout (id, type, createdAt, deleted, body) inside a
// temp directory, points the tool at a throwaway Postgres database, and asserts the proof the
// tool promises: same counts, same ids, bodies equal, and the old file renamed -- never
// deleted -- once the checks pass. A row that fails to convert stops the migration and is
// reported by id; the second half of the probe plants such a row and expects exactly that.

import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import pg from "pg"

import { makeScore } from "./lib.mjs"
import { createScratchDatabase, dropScratchDatabase } from "./pg-scratch.mjs"

const score = makeScore()
const dataDir = mkdtempSync(join(tmpdir(), "store-migration-"))
const adminUrl = process.env.QWBE_TEST_ADMIN_URL ?? adminUrlFromEnv()
const db = await createScratchDatabase("storemig", adminUrl)
process.env.QWBE_DATABASE_URL = db.url
process.env.QWBE_DATA_DIR = dataDir

const plant = (file, rows) => {
  const sqlite = new DatabaseSync(file)
  sqlite.exec(
    `CREATE TABLE contacts (id TEXT PRIMARY KEY, type TEXT NOT NULL, createdAt TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL)`,
  )
  for (const r of rows)
    sqlite
      .prepare(`INSERT INTO contacts (id, type, createdAt, deleted, body) VALUES (?, ?, ?, ?, ?)`)
      .run(r.id, r.type, r.createdAt, r.deleted, r.body)
  sqlite.close()
}

const iso = (i) => new Date(Date.UTC(2026, 7, 30, 12, 0, i)).toISOString()

// --- 1. a good file migrates and is renamed ---
const good = join(dataDir, "crm--contacts.sqlite")
plant(good, [
  {
    id: "con-0001",
    type: "contact",
    createdAt: iso(0),
    deleted: 0,
    body: JSON.stringify({ name: "Ada", phone: "+40 21" }),
  },
  {
    id: "con-0002",
    type: "contact",
    createdAt: iso(1),
    deleted: 0,
    body: JSON.stringify({ name: "Bruno", nested: { a: 1, b: [1, 2] } }),
  },
  { id: "con-0003", type: "contact", createdAt: iso(2), deleted: 1, body: JSON.stringify({ name: "Cleo" }) },
])

const run = await import("../core/src/migrate-sqlite-to-pg.ts")
const { initStore, closeAll } = await import("../core/src/pg/db.ts")
const client = new pg.Client({ connectionString: db.url })
await client.connect()
await initStore()

try {
  const result = await run.migrateFile(client, good)
  score.check("the file's rows are all copied", result.rows === 3, `rows=${result.rows}`)
  const count = await client.query(`SELECT COUNT(*)::int AS c FROM "crm--contacts"."contacts"`)
  score.check("postgres holds the same count", count.rows[0].c === 3, `pg=${count.rows[0].c}`)
  const body = await client.query(`SELECT body::text AS b FROM "crm--contacts"."contacts" WHERE id = 'con-0002'`)
  const parsed = JSON.parse(body.rows[0].b)
  score.check("a nested body survives the copy", parsed.nested?.b?.[1] === 2, JSON.stringify(parsed))
  const deleted = await client.query(`SELECT deleted FROM "crm--contacts"."contacts" WHERE id = 'con-0003'`)
  score.check("a soft-deleted row stays deleted", deleted.rows[0].deleted === true)
  const to = run.renameMigrated(good)
  score.check("the old file is renamed, not deleted", existsSync(to) && !existsSync(good), to.split("/").pop())

  // --- 2. a row that cannot convert stops the migration, named by id ---
  const bad = join(dataDir, "crm--deals.sqlite")
  plant(bad, [
    { id: "deal-0001", type: "deal", createdAt: iso(3), deleted: 0, body: JSON.stringify({ value: 10 }) },
    { id: "deal-0002", type: "deal", createdAt: "not-a-timestamp", deleted: 0, body: JSON.stringify({ value: 20 }) },
  ])
  let stopped = ""
  try {
    await run.migrateFile(client, bad)
  } catch (e) {
    stopped = e.message
  }
  score.check(
    "a row that fails to convert stops the migration and is reported by id",
    stopped.includes("deal-0002"),
    stopped,
  )
} finally {
  await client.end().catch(() => {})
  await closeAll() // release the kernel pool before the database is dropped
  await dropScratchDatabase(db, adminUrl)
  rmSync(dataDir, { recursive: true, force: true })
}

process.exit(score.report("Store migration probe - SQLite into Postgres, proven or refused"))

function adminUrlFromEnv() {
  const u = new URL("postgres://localhost/postgres")
  u.hostname = process.env.QWBE_PG_HOST ?? "localhost"
  u.port = process.env.QWBE_PG_PORT ?? "5433"
  u.username = process.env.QWBE_PG_USER ?? "postgres"
  u.password = process.env.QWBE_PG_PASSWORD ?? "qwbe"
  return u.toString()
}
