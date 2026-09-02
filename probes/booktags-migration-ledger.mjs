// The ledger fail-open attacks: provenance that is missing, corrupt, or rewritten by the
// attacker's own top-level code.
//
//   node probes/booktags-migration-ledger.mjs

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { coreDir, dropDatabase, freePort, makeScore, scratchDatabase, startServer } from "./lib.mjs"
import { plantAuthSchema, schemaThere } from "./pg-scratch.mjs"

// The legacy data a migration would move lives in a Postgres schema, not a
// SQLite file -- the planted victim is an "auth" schema in the probe's scratch database.
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

// Attack 4, the fail-open: the ledger is MISSING entirely (or corrupt) and the victim is not
// mounted. Before the fix this walked through every check. Now: no ledger record means the
// source is refused without the operator's explicit legacy authorization.
const dataDir4 = join(tmpdir(), `qwbe-evil4-${process.pid}`)
mkdirSync(dataDir4, { recursive: true })
const dbUrl4 = await scratchDatabase("evil4")
await plantAuthSchema(dbUrl4)
const evilPlugin4 = join(coreDir, "plugins", "evil-plugin", "cubes", "evil-migration")
mkdirSync(evilPlugin4, { recursive: true })
evilManifest(join(coreDir, "plugins", "evil-plugin"))
writeFileSync(
  join(evilPlugin4, "index.ts"),
  EVIL_CUBE(`{ fromCube: "auth", toCube: "evil-migration", fromPlugin: "evil-plugin" }`),
)
const evil4 = await startServer(await freePort(), {
  QWBE_DATA_DIR: dataDir4,
  QWBE_DATABASE_URL: dbUrl4,
  QWBE_MOUNTED: "account,settings,cli,evil-migration",
})
score.check(
  "ledger absent, victim unmounted: the source is refused, boot stops",
  !evil4.alive && evil4.output.includes("no record"),
  evil4.output.split("\n").find((l) => l.includes("record") || l.includes("igration")) ?? "(no error line)",
)
score.check(
  "the auth schema was NOT renamed (ledger absent)",
  (await schemaThere(dbUrl4, "auth")) && !(await schemaThere(dbUrl4, "evil-migration")),
  "schema untouched",
)
evil4.proc.kill()

// Attack 4b: the ledger is CORRUPT -- present but unreadable. A ledger that cannot be read is
// not an empty ledger: the boot stops on the corrupt file itself, before any migration check.
writeFileSync(join(dataDir4, "provenance.json"), "{ not json")
const evil4b = await startServer(await freePort(), {
  QWBE_DATA_DIR: dataDir4,
  QWBE_DATABASE_URL: dbUrl4,
  QWBE_MOUNTED: "account,settings,cli,evil-migration",
})
score.check(
  "ledger corrupt: the boot stops on the corrupt ledger, not on a guess",
  !evil4b.alive && evil4b.output.includes("provenance ledger"),
  evil4b.output.split("\n").find((l) => l.includes("ledger")) ?? "(no error line)",
)
score.check(
  "the auth schema was NOT renamed (ledger corrupt)",
  (await schemaThere(dbUrl4, "auth")) && !(await schemaThere(dbUrl4, "evil-migration")),
  "schema untouched",
)
evil4b.proc.kill()

// Attack 4c: valid JSON with an invalid ledger SHAPE is corrupt too. A cast would accept it.
writeFileSync(join(dataDir4, "provenance.json"), JSON.stringify({ auth: 42 }))
const evil4c = await startServer(await freePort(), {
  QWBE_DATA_DIR: dataDir4,
  QWBE_DATABASE_URL: dbUrl4,
  QWBE_MOUNTED: "account,settings,cli,evil-migration",
})
score.check(
  "ledger with a non-string owner is corrupt and stops boot",
  !evil4c.alive && evil4c.output.includes("invalid package owner"),
  evil4c.output.split("\n").find((l) => l.includes("owner") || l.includes("ledger")) ?? "(no error line)",
)
score.check(
  "the auth schema was NOT renamed (ledger shape invalid)",
  (await schemaThere(dbUrl4, "auth")) && !(await schemaThere(dbUrl4, "evil-migration")),
  "schema untouched",
)
evil4c.proc.kill()
rmSync(join(coreDir, "plugins", "evil-plugin"), { recursive: true, force: true })
await dropDatabase(dbUrl4)
rmSync(dataDir4, { recursive: true, force: true })

// Attack 5: the plugin's TOP-LEVEL code rewrites the ledger at import time, before the mount
// checks run. The snapshot is taken before any import (main.ts), so the rewrite lands but the
// check reads the snapshot -- and the file stays.
const dataDir5 = join(tmpdir(), `qwbe-evil5-${process.pid}`)
mkdirSync(dataDir5, { recursive: true })
const dbUrl5 = await scratchDatabase("evil5")
await plantAuthSchema(dbUrl5)
writeFileSync(join(dataDir5, "provenance.json"), JSON.stringify({ auth: null }, null, 2))
const evilPlugin5 = join(coreDir, "plugins", "evil-plugin", "cubes", "evil-migration")
mkdirSync(evilPlugin5, { recursive: true })
evilManifest(join(coreDir, "plugins", "evil-plugin"))
// The poison sits in a package file OUTSIDE cubes/, and the cube imports it. Deliberate: the
// package contract bans node:fs in a CUBE, so an attack written inside the cube would now be
// refused by the boot gate and this probe would stop proving what it is here to prove
// -- that the ledger snapshot survives a plugin running code at import. The package-root file
// is the shape a real attacker would use, and the one the contract still allows.
writeFileSync(
  join(coreDir, "plugins", "evil-plugin", "poison.ts"),
  `import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
// The attack poisons only boot 1. Boot 2 proves a rejected import cannot leave authority
// behind for the next process.
const marker = join(process.env.QWBE_DATA_DIR, "poisoned-once")
if (!existsSync(marker)) {
  writeFileSync(join(process.env.QWBE_DATA_DIR, "provenance.json"), JSON.stringify({ auth: "evil-plugin" }))
  writeFileSync(marker, "yes")
}
`,
)
writeFileSync(
  join(evilPlugin5, "index.ts"),
  `import "../../poison.ts"
export const cube = {
  manifest: {
    name: "evil-migration",
    tables: [],
    requiresAuth: false,
    dataMigration: [{ fromCube: "auth", toCube: "evil-migration", fromPlugin: "evil-plugin" }],
  },
  create: () => ({ group: null, handlers: {} }),
}
`,
)
const evil5 = await startServer(await freePort(), {
  QWBE_DATA_DIR: dataDir5,
  QWBE_DATABASE_URL: dbUrl5,
  QWBE_MOUNTED: "account,settings,cli,evil-migration",
})
score.check(
  "a plugin rewriting the ledger at import is caught by the pre-import snapshot",
  !evil5.alive && evil5.output.includes("ledger changed after the trusted pre-import snapshot"),
  evil5.output.split("\n").find((l) => l.includes("ledger") || l.includes("igration")) ?? "(no error line)",
)
score.check(
  "the auth schema was NOT renamed (ledger rewritten at import)",
  (await schemaThere(dbUrl5, "auth")) && !(await schemaThere(dbUrl5, "evil-migration")),
  "schema untouched",
)
evil5.proc.kill()
const evil5second = await startServer(await freePort(), {
  QWBE_DATA_DIR: dataDir5,
  QWBE_DATABASE_URL: dbUrl5,
  QWBE_MOUNTED: "account,settings,cli,evil-migration",
})
score.check(
  "boot 2 refuses the ledger poison left by the rejected first boot",
  !evil5second.alive,
  evil5second.output.split("\n").find((l) => l.includes("ledger") || l.includes("igration")) ?? "(no error line)",
)
score.check(
  "the auth schema is still untouched after the second boot",
  (await schemaThere(dbUrl5, "auth")) && !(await schemaThere(dbUrl5, "evil-migration")),
  "schema untouched twice",
)
evil5second.proc.kill()
rmSync(join(coreDir, "plugins", "evil-plugin"), { recursive: true, force: true })
await dropDatabase(dbUrl5)
rmSync(dataDir5, { recursive: true, force: true })

process.exit(score.report("Booktags migration ledger probe"))
