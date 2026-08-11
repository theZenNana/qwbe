// The migration ownership walls, attacked for real: a cube whose dataMigration points at
// another package's data must be refused at mount. Split out of booktags-migration.mjs on
// 2026-08-11 (file cap -- "split the file, don't raise the number").
//
//   node probes/booktags-migration-ownership.mjs
//
// Two attacks, both planted as REAL directories -- the way a malicious package would look:
//   1. a core cube claiming its migration came from a plugin (provenance lie);
//   2. a PLUGIN cube whose migration source is the LIVE `auth` cube of core (theft).

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { coreDir, freePort, makeScore, startServer } from "./lib.mjs"

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

// Attack 1: the provenance claim is a lie. The cube says its data came from example-plugin;
// the destination belongs to core. The claimed history is not this package's.
const evilDir = join(coreDir, "src", "cubes", "evil-migration")
mkdirSync(evilDir, { recursive: true })
writeFileSync(
  join(evilDir, "index.ts"),
  EVIL_CUBE(`{ fromCube: "auth", toCube: "evil-migration", fromPlugin: "example-plugin" }`),
)
const dataDir1 = join(tmpdir(), `qwbe-evil-${process.pid}`)
mkdirSync(dataDir1, { recursive: true })
const evil = await startServer(await freePort(), {
  QWBE_DATA_DIR: dataDir1,
  QWBE_MOUNTED: "auth,account,settings,cli,evil-migration",
})
score.check(
  "a migration claiming another package's provenance stops the boot",
  !evil.alive && evil.output.includes("claimed provenance"),
  evil.output.split("\n").find((l) => l.includes("migration") || l.includes("provenance")) ?? "(no error line)",
)
evil.proc.kill()
rmSync(evilDir, { recursive: true, force: true })
rmSync(dataDir1, { recursive: true, force: true })

// Attack 2: no provenance claimed at all, but the SOURCE is a live mounted cube of core
// while the declarer is a PLUGIN. Moving auth.sqlite would be theft, not migration.
const evilPluginDir = join(coreDir, "plugins", "evil-plugin", "cubes", "evil-migration")
mkdirSync(evilPluginDir, { recursive: true })
writeFileSync(join(evilPluginDir, "index.ts"), EVIL_CUBE(`{ fromCube: "auth", toCube: "evil-migration" }`))
const dataDir2 = join(tmpdir(), `qwbe-evil2-${process.pid}`)
mkdirSync(dataDir2, { recursive: true })
const evil2 = await startServer(await freePort(), {
  QWBE_DATA_DIR: dataDir2,
  QWBE_MOUNTED: "auth,account,settings,cli,evil-migration",
})
score.check(
  "a plugin migration whose source is a LIVE core cube stops the boot",
  !evil2.alive && evil2.output.includes("its file is live"),
  evil2.output.split("\n").find((l) => l.includes("live") || l.includes("igration")) ?? "(no error line)",
)
evil2.proc.kill()
rmSync(join(coreDir, "plugins", "evil-plugin"), { recursive: true, force: true })
rmSync(dataDir2, { recursive: true, force: true })

process.exit(score.report("Booktags migration ownership probe"))
