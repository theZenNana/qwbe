// Drop the test databases that killed runs leak (the stopServer/after cleanup never
// fires on a killed suite). Left in place, they make every later npm test crawl
// (300s+ instead of 7.5s). Explicit prefixes only -- qwbe_crm_local (the demo stack)
// can never match. Orphan kernel PROCESSES stay out of this script on purpose: a
// pkill pattern here is one typo away from killing a legitimate suite (2026-09-02).

import pg from "pg"

const LEAK_PREFIXES = ["qwbe_qwb50_", "qwbe_ticket05_", "qwbe_test_", "qwbe_probe_"]

const adminUrl = () => {
  const u = new URL("postgres://localhost/postgres")
  u.hostname = process.env.QWBE_PG_HOST ?? "localhost"
  u.port = process.env.QWBE_PG_PORT ?? "5433"
  u.username = process.env.QWBE_PG_USER ?? "postgres"
  u.password = process.env.QWBE_PG_PASSWORD ?? "qwbe"
  return u.toString()
}

const admin = new pg.Pool({ connectionString: adminUrl(), max: 1 })
const where = LEAK_PREFIXES.map((_, i) => `datname LIKE $${i + 1}`).join(" OR ")
const found = await admin.query(
  `SELECT datname FROM pg_database WHERE ${where} ORDER BY datname`,
  LEAK_PREFIXES.map((p) => `${p}%`),
)
if (found.rows.length === 0) {
  console.log("pg-clean: nothing to drop")
} else {
  for (const { datname } of found.rows) {
    await admin.query(`DROP DATABASE "${datname}" WITH (FORCE)`)
    console.log(`pg-clean: dropped ${datname}`)
  }
  console.log(`pg-clean: ${found.rows.length} database(s) dropped`)
}
await admin.end()
