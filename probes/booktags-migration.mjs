// The migration edge cases: conflict on the SECOND entry, preflight before ANY rename.
//
//   node probes/booktags-migration.mjs
//
// The main probe migrates a clean flat schema. This one plants the trap the reviewer
// described: the FIRST migration is clean, the SECOND finds both schemas present. Preflight
// must refuse the boot BEFORE the first rename -- the database afterwards must hold exactly
// what it held before. And a sub-directory without an index.ts next to the children must be
// ignored, not imported.
//
// The data lives in one Postgres schema per cube, so the planted history is a
// set of schemas in a scratch database, and a mid-batch rollback is no longer reachable from
// the outside (a schema rename has no filesystem permission to deny) -- that path is covered
// by the unit test in core/src/kernel/migrate.test.ts, which injects a failing renamer.

import pg from "pg"
import { dropDatabase, freePort, makeScore, scratchDatabase, startServer } from "./lib.mjs"

const score = makeScore()
const dbUrl = await scratchDatabase("migration")

const plant = async (schema, table) => {
  const c = new pg.Client({ connectionString: dbUrl })
  await c.connect()
  try {
    await c.query(`CREATE SCHEMA "${schema}"`)
    await c.query(`CREATE TABLE "${schema}"."${table}" (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, created_at timestamptz NOT NULL,
      deleted BOOLEAN NOT NULL DEFAULT false, version INTEGER NOT NULL DEFAULT 1, body JSONB NOT NULL)`)
    await c.query(
      `INSERT INTO "${schema}"."${table}" (id, type, created_at, deleted, version, body)
       VALUES ($1, 'T', now(), false, 1, '{}')`,
      [`${table}-1`],
    )
  } finally {
    await c.end()
  }
}

const schemaThere = async (schema) => {
  const c = new pg.Client({ connectionString: dbUrl })
  await c.connect()
  try {
    const r = await c.query(`SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [schema])
    return (r.rowCount ?? 0) > 0
  } finally {
    await c.end()
  }
}

// bookmarks migrates cleanly; tags + booktags--tags collide.
await plant("bookmarks", "bookmarks")
await plant("tags", "tags")
await plant("booktags--tags", "tags")

const LEGACY = "bookmarks:example-plugin,tags:example-plugin"
const server = await startServer(await freePort(), { QWBE_DATABASE_URL: dbUrl, QWBE_LEGACY_MIGRATIONS: LEGACY })
score.check(
  "a conflict on the second migration stops the boot with the named refusal",
  !server.alive && server.output.includes("Data migration refused"),
  server.output.split("\n").find((l) => l.includes("migration")) ?? "(no error line)",
)
score.check(
  "preflight ran before ANY rename: the first migration's source is still in place",
  (await schemaThere("bookmarks")) && !(await schemaThere("booktags--bookmarks")),
  "nothing moved",
)
score.check(
  "the conflicting pair is untouched, both directions",
  (await schemaThere("tags")) && (await schemaThere("booktags--tags")),
  "both schemas present",
)

await dropDatabase(dbUrl)

// Two mount-selection rules, both verified by booting a narrowed set:
//   - a child requested without its parent pulls the parent in (the mask requires it);
//   - a package whose migration destination is NOT mounted refuses the boot -- a migration
//     runs only when its destination is, so half the package cannot slip through.
const dbUrl2 = await scratchDatabase("migration-mounted")
const childOnly = await startServer(await freePort(), {
  QWBE_DATABASE_URL: dbUrl2,
  QWBE_MOUNTED: "auth,account,settings,cli,booktags/bookmarks",
})
score.check(
  "a declared migration whose destination is not mounted stops the boot",
  !childOnly.alive && childOnly.output.includes("not mounted"),
  childOnly.output.split("\n").find((l) => l.includes("migration")) ?? "(no error line)",
)
childOnly.proc.kill()

const wholePackage = await startServer(await freePort(), {
  QWBE_DATABASE_URL: dbUrl2,
  QWBE_MOUNTED: "auth,account,settings,cli,booktags,booktags/bookmarks,booktags/tags,booktags/settings",
})
score.check(
  "the whole package mounted (with every migration destination) boots cleanly",
  wholePackage.alive,
  wholePackage.alive ? "booted" : wholePackage.output.split("\n")[0],
)
wholePackage.proc.kill()

// The expansion itself: asking for the children and NOT the parent still mounts the parent.
const childPullsParent = await startServer(await freePort(), {
  QWBE_DATABASE_URL: dbUrl2,
  QWBE_MOUNTED: "auth,account,settings,cli,booktags/bookmarks,booktags/tags,booktags/settings",
})
score.check(
  "a child requested without its parent pulls the parent into the mount",
  childPullsParent.alive,
  childPullsParent.alive ? "booted with parent expanded" : childPullsParent.output.split("\n")[0],
)
childPullsParent.proc.kill()

await dropDatabase(dbUrl2)

process.exit(score.report("Booktags migration probe"))
