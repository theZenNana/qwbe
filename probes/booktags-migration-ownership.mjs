// The migration ownership walls, attacked for real: a cube whose dataMigration points at
// another package's data must be refused at mount.
//
//   node probes/booktags-migration-ownership.mjs
//
// Two attacks, both planted as REAL directories -- the way a malicious package would look:
//   1. a core cube claiming its migration came from a plugin (provenance lie);
//   2. a PLUGIN cube whose migration source is the LIVE `auth` cube of core (theft).

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { coreDir, dropDatabase, freePort, makeScore, scratchDatabase, startServer } from "./lib.mjs"
import { plantAuthSchema, schemaThere } from "./pg-scratch.mjs"

// The legacy data a migration would move lives in a Postgres schema, not a
// SQLite file -- so the planted victim is an "auth" schema in the probe's scratch database.
const score = makeScore()

const EVIL_CUBE = (migration) => `export const cube = {
  manifest: {
    name: "evil-migration",
    tables: [],
    requiresAuth: false,
    dataMigration: [${migration}],
  },
  create: () => ({ group: null, handlers: {} }),
}
`

// The kernel checks each package's contract before mounting it, so the fixture ships
// the manifest a real package ships -- otherwise the boot stops on the manifest and never
// reaches the ownership rule under test.
const evilManifest = (dir) =>
  writeFileSync(
    join(dir, "qwbe-package.json"),
    JSON.stringify({ name: "evil-plugin", kind: "plugin", cubes: ["evil-migration"] }),
  )

// Attack 1: the provenance claim contradicts the LEDGER. The victim is not mounted, its file
// exists, and the ledger says auth belongs to core -- the cube claims example-plugin.
const evilDir = join(coreDir, "src", "cubes", "evil-migration")
mkdirSync(evilDir, { recursive: true })
writeFileSync(
  join(evilDir, "index.ts"),
  EVIL_CUBE(`{ fromCube: "auth", toCube: "evil-migration", fromPlugin: "example-plugin" }`),
)
const dataDir1 = join(tmpdir(), `qwbe-evil-${process.pid}`)
mkdirSync(dataDir1, { recursive: true })
const dbUrl1 = await scratchDatabase("evil1")
await plantAuthSchema(dbUrl1)
writeFileSync(join(dataDir1, "provenance.json"), JSON.stringify({ auth: null }, null, 2))
const evil = await startServer(await freePort(), {
  QWBE_DATA_DIR: dataDir1,
  QWBE_DATABASE_URL: dbUrl1,
  QWBE_MOUNTED: "account,settings,cli,evil-migration",
})
score.check(
  "a provenance claim contradicting the ledger stops the boot",
  !evil.alive && evil.output.includes("ledger records"),
  evil.output.split("\n").find((l) => l.includes("ledger") || l.includes("igration")) ?? "(no error line)",
)
evil.proc.kill()
rmSync(evilDir, { recursive: true, force: true })
await dropDatabase(dbUrl1)
rmSync(dataDir1, { recursive: true, force: true })

// Attack 2: no provenance claimed at all, with the LIVE auth cube mounted alongside. Two
// walls catch it -- the mounted-source rule fires first; the required fromPlugin would have.
const evilPluginDir = join(coreDir, "plugins", "evil-plugin", "cubes", "evil-migration")
mkdirSync(evilPluginDir, { recursive: true })
evilManifest(join(coreDir, "plugins", "evil-plugin"))
writeFileSync(join(evilPluginDir, "index.ts"), EVIL_CUBE(`{ fromCube: "auth", toCube: "evil-migration" }`))
const dataDir2 = join(tmpdir(), `qwbe-evil2-${process.pid}`)
mkdirSync(dataDir2, { recursive: true })
const evil2 = await startServer(await freePort(), {
  QWBE_DATA_DIR: dataDir2,
  QWBE_MOUNTED: "auth,account,settings,cli,evil-migration",
})
score.check(
  "a plugin migration naming a live core cube as source stops the boot",
  !evil2.alive && evil2.output.includes("is live, not legacy"),
  evil2.output.split("\n").find((l) => l.includes("live") || l.includes("igration")) ?? "(no error line)",
)
evil2.proc.kill()
rmSync(join(coreDir, "plugins", "evil-plugin"), { recursive: true, force: true })
rmSync(dataDir2, { recursive: true, force: true })

// Attack 3, the one that needed the ledger: the victim is NOT mounted. auth.sqlite exists
// (auth ran once, so the LEDGER records auth -> core), but auth is absent from QWBE_MOUNTED,
// so it never enters the mounted map. Without the ledger every check passed and the file
// moved. Boot sequence: first a clean boot with auth to write the ledger, then the attack.
const dataDir3 = join(tmpdir(), `qwbe-evil3-${process.pid}`)
mkdirSync(dataDir3, { recursive: true })
const dbUrl3 = await scratchDatabase("evil3")
await plantAuthSchema(dbUrl3)
// The ledger entry as a real past boot would have written it. Planted directly because the
// data directory is the probe's fixture; what is under test is that the kernel READS it.
writeFileSync(join(dataDir3, "provenance.json"), JSON.stringify({ auth: null }, null, 2))
const evilPlugin3 = join(coreDir, "plugins", "evil-plugin", "cubes", "evil-migration")
mkdirSync(evilPlugin3, { recursive: true })
evilManifest(join(coreDir, "plugins", "evil-plugin"))
writeFileSync(
  join(evilPlugin3, "index.ts"),
  EVIL_CUBE(`{ fromCube: "auth", toCube: "evil-migration", fromPlugin: "evil-plugin" }`),
)
const evil3 = await startServer(await freePort(), {
  QWBE_DATA_DIR: dataDir3,
  QWBE_DATABASE_URL: dbUrl3,
  QWBE_MOUNTED: "account,settings,cli,evil-migration",
})
score.check(
  "victim absent from the mount: the ledger still names its owner, boot stops",
  !evil3.alive && evil3.output.includes("ledger"),
  evil3.output.split("\n").find((l) => l.includes("ledger") || l.includes("igration")) ?? "(no error line)",
)
score.check(
  "the auth schema was NOT renamed by the refused migration",
  (await schemaThere(dbUrl3, "auth")) && !(await schemaThere(dbUrl3, "evil-migration")),
  "schema untouched",
)
evil3.proc.kill()
await dropDatabase(dbUrl3)
rmSync(join(coreDir, "plugins", "evil-plugin"), { recursive: true, force: true })
rmSync(dataDir3, { recursive: true, force: true })

// The fail-open attacks (ledger absent, corrupt, rewritten at import) live in
// booktags-migration-ledger.mjs -- file cap.

process.exit(score.report("Booktags migration ownership probe"))
