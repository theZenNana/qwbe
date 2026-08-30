// One Postgres database, one schema per cube (ADR-0001, QWB-44).
//
// The SQLite file boundary made isolation physical. The move to Postgres buys transactions,
// migrations, jsonb with GIN and a real pool, and spends that physical boundary -- so the
// boundary is rebuilt in the engine: one NOLOGIN role per cube, one schema per cube, and every
// store operation running under `SET LOCAL ROLE` inside its transaction. A cube's connection
// that asks for another cube's schema gets a permission error from Postgres, not a warning
// from lint. See `setup.ts` for the grants and `probes/store-isolation.mjs` for the proof.
//
// The kernel owns one schema of its own, `qwbe`: `qwbe.migrations` records which numbered SQL
// files under `pg/migrations/` were applied, and `qwbe.outbox` receives one row per write,
// in the same transaction as the write itself (ADR-0001 section 5). Nothing consumes the
// outbox in phase 1.

import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"

const here = dirname(fileURLToPath(import.meta.url))

export type Pool = pg.Pool

let pool: Pool | null = null
let migrated = false

/**
 * The one connection string. Missing or unreachable at boot means REFUSE TO START: a fallback
 * (SQLite, memory, anything) would create two storage truths and the quiet data loss that
 * follows. The message names the variable, because that is what the operator can fix.
 */
export const databaseUrl = (): string => {
  const url = process.env.QWBE_DATABASE_URL
  if (!url) {
    throw new Error(
      "QWBE_DATABASE_URL is not set. qwbe stores every cube in one Postgres database and " +
        "refuses to start without it. Set it, e.g. to the value in .env.example, and start the " +
        "database with `npm run db:up`.",
    )
  }
  return url
}

export const getPool = (): Pool => {
  if (!pool) pool = new pg.Pool({ connectionString: databaseUrl(), max: 10 })
  return pool
}

/** Close everything. Used by the probes and tests so a run leaves no connections behind. */
export const closeAll = async (): Promise<void> => {
  if (pool) {
    await pool.end()
    pool = null
  }
  migrated = false
}

/**
 * Kernel-owned SQL, applied in order, recorded in `qwbe.migrations`. Applied at boot: an
 * unapplied migration runs, a failing one stops the boot -- no guessing, no half-state (the
 * runner is one transaction per file, so a failure leaves no partial DDL behind).
 */
export const runMigrations = async (p: Pool): Promise<void> => {
  const dir = join(here, "migrations")
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
  // One session-level advisory lock around the whole loop: two processes booting against the
  // same database must not both run the same file -- the second would die on the
  // qwbe.migrations primary key. Session-scoped locks live per connection, so the lock is
  // taken and held on one dedicated client for the duration and released after the loop.
  const lockClient = await p.connect()
  try {
    await lockClient.query(`SELECT pg_advisory_lock(hashtext('qwbe-migrations'))`)
    for (const file of files) {
      // Only "relation does not exist" (42P01) means "not applied yet": the kernel schema
      // simply is not there on a first boot. EVERY other failure of this probe -- a dropped
      // connection, a permission error -- must stop the boot, because reading it as "not
      // applied" would re-run an already-applied file.
      const applied = await p
        .query(`SELECT 1 FROM qwbe.migrations WHERE name = $1`, [file])
        .catch((e: { code?: string }) => {
          if (e?.code === "42P01") return null
          throw e
        })
      if (applied?.rowCount === 1) continue
      const sql = readFileSync(join(dir, file), "utf8")
      const client = await p.connect()
      let failed = false
      try {
        await client.query("BEGIN")
        await client.query(sql)
        await client.query(`INSERT INTO qwbe.migrations (name) VALUES ($1)`, [file])
        await client.query("COMMIT")
      } catch (e) {
        failed = true
        await client.query("ROLLBACK").catch(() => {})
        client.release(e as Error)
        throw new Error(`Postgres migration "${file}" failed and the boot stopped: ${(e as Error).message}`)
      } finally {
        if (!failed) client.release()
      }
    }
  } finally {
    await lockClient.query(`SELECT pg_advisory_unlock(hashtext('qwbe-migrations'))`).catch(() => {})
    lockClient.release()
  }
}

/**
 * Boot-time initialisation: connect, make sure the kernel schema exists, apply migrations.
 * Called once from `main.ts` before mount; the store refuses to work without it, because a
 * schema change applied by a request instead of at boot is exactly the guessing ADR-0001
 * section 4 forbids.
 */
export const initStore = async (): Promise<void> => {
  if (migrated) return
  const p = getPool()
  await p.query(`SELECT 1`) // unreachable database fails here, with pg's own error
  await runMigrations(p)
  migrated = true
}
