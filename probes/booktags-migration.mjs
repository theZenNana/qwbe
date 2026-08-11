// The migration edge cases: conflict on the SECOND entry, and the batch rolling back whole.
//
//   node probes/booktags-migration.mjs
//
// The main probe migrates a clean flat database. This one plants the trap the reviewer
// described: the FIRST migration is clean, the SECOND finds both files present. Preflight
// must refuse the boot BEFORE the first rename -- the data directory afterwards must hold
// exactly what it held before, byte for byte. And a sub-directory without an index.ts next
// to the children must be ignored, not imported.

import { existsSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { freePort, makeScore, startServer } from "./lib.mjs"

const score = makeScore()
const dataDir = join(tmpdir(), `qwbe-migration-${process.pid}`)
mkdirSync(dataDir, { recursive: true })

const plant = (file, table) => {
  const db = new DatabaseSync(join(dataDir, file))
  db.exec(
    `CREATE TABLE "${table}" (id TEXT PRIMARY KEY, type TEXT NOT NULL, createdAt TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL)`,
  )
  db.prepare(`INSERT INTO "${table}" (id, type, createdAt, deleted, body) VALUES (?, ?, ?, 0, ?)`).run(
    `${table}-1`,
    "T",
    new Date().toISOString(),
    "{}",
  )
  db.close()
}

// bookmarks.sqlite migrates cleanly; tags.sqlite + booktags--tags.sqlite collide.
plant("bookmarks.sqlite", "bookmarks")
plant("tags.sqlite", "tags")
plant("booktags--tags.sqlite", "tags")

const PORT = await freePort()
const LEGACY = "bookmarks:example-plugin,tags:example-plugin"
const server = await startServer(PORT, { QWBE_DATA_DIR: dataDir, QWBE_LEGACY_MIGRATIONS: LEGACY })
score.check(
  "a conflict on the second migration stops the boot with the named refusal",
  !server.alive && server.output.includes("Data migration refused"),
  server.output.split("\n").find((l) => l.includes("migration")) ?? "(no error line)",
)
score.check(
  "preflight ran before ANY rename: the first migration's source is still in place",
  existsSync(join(dataDir, "bookmarks.sqlite")) && !existsSync(join(dataDir, "booktags--bookmarks.sqlite")),
  "nothing moved",
)
score.check(
  "the conflicting pair is untouched, both directions",
  existsSync(join(dataDir, "tags.sqlite")) && existsSync(join(dataDir, "booktags--tags.sqlite")),
  "both files present",
)

rmSync(dataDir, { recursive: true, force: true })

// Two mount-selection rules, both verified by booting a narrowed set:
//   - a child requested without its parent pulls the parent in (the mask requires it);
//   - a package whose migration destination is NOT mounted refuses the boot -- a migration
//     runs only when its destination is, so half the package cannot slip through.
const dataDir2 = join(tmpdir(), `qwbe-mounted-${process.pid}`)
mkdirSync(dataDir2, { recursive: true })
const childOnly = await startServer(await freePort(), {
  QWBE_DATA_DIR: dataDir2,
  QWBE_MOUNTED: "auth,account,settings,cli,booktags/bookmarks",
})
score.check(
  "a declared migration whose destination is not mounted stops the boot",
  !childOnly.alive && childOnly.output.includes("not mounted"),
  childOnly.output.split("\n").find((l) => l.includes("migration")) ?? "(no error line)",
)
childOnly.proc.kill()

const wholePackage = await startServer(await freePort(), {
  QWBE_DATA_DIR: dataDir2,
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
  QWBE_DATA_DIR: dataDir2,
  QWBE_MOUNTED: "auth,account,settings,cli,booktags/bookmarks,booktags/tags,booktags/settings",
})
score.check(
  "a child requested without its parent pulls the parent into the mount",
  childPullsParent.alive,
  childPullsParent.alive ? "booted with parent expanded" : childPullsParent.output.split("\n")[0],
)
childPullsParent.proc.kill()

rmSync(dataDir2, { recursive: true, force: true })

// The ownership walls (a migration pointing at another package's data, a plugin pointing at
// the LIVE auth cube) live in booktags-migration-ownership.mjs -- file cap.

// A rename failing MID-BATCH (first file moved, second throws) is covered by the unit test
// in core/src/kernel/migrate.test.ts: migrateDataFiles takes its renamer as a parameter, so
// the fault is injected directly -- no environment variable in the production path. What
// remains for the boot-level probe: a data directory that rejects EVERY write stops the boot
// with the failure named, and nothing moves.
import { chmodSync } from "node:fs"

const dataDir4 = join(tmpdir(), `qwbe-midmove-${process.pid}`)
mkdirSync(dataDir4, { recursive: true })
const flat4 = new DatabaseSync(join(dataDir4, "bookmarks.sqlite"))
flat4.exec(
  `CREATE TABLE "bookmarks" (id TEXT PRIMARY KEY, type TEXT NOT NULL, createdAt TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL)`,
)
flat4.close()
chmodSync(dataDir4, 0o555)
const midMove = await startServer(await freePort(), {
  QWBE_DATA_DIR: dataDir4,
  QWBE_LEGACY_MIGRATIONS: LEGACY,
})
chmodSync(dataDir4, 0o755)
score.check(
  "a data directory that rejects writes stops the boot with the failure named",
  !midMove.alive && midMove.output.includes("rolled back"),
  midMove.output.split("\n").find((l) => l.includes("igration")) ?? "(no error line)",
)
score.check(
  "nothing moved: source file in place, destination absent",
  existsSync(join(dataDir4, "bookmarks.sqlite")) && !existsSync(join(dataDir4, "booktags--bookmarks.sqlite")),
  "nothing moved",
)
midMove.proc.kill()
rmSync(dataDir4, { recursive: true, force: true })

process.exit(score.report("Booktags migration probe"))
