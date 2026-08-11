// The ledger fail-open attacks: provenance that is missing, corrupt, or rewritten by the
// attacker's own top-level code. Split out of booktags-migration-ownership.mjs on 2026-08-11
// (file cap -- "split the file, don't raise the number").
//
//   node probes/booktags-migration-ledger.mjs

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
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

// Attack 4, the fail-open: the ledger is MISSING entirely (or corrupt) and the victim is not
// mounted. Before the fix this walked through every check. Now: no ledger record means the
// source is refused without the operator's explicit legacy authorization.
const dataDir4 = join(tmpdir(), `qwbe-evil4-${process.pid}`)
mkdirSync(dataDir4, { recursive: true })
const authdb4 = new DatabaseSync(join(dataDir4, "auth.sqlite"))
authdb4.exec(
  `CREATE TABLE "sessions" (id TEXT PRIMARY KEY, type TEXT NOT NULL, createdAt TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL)`,
)
authdb4.close()
const evilPlugin4 = join(coreDir, "plugins", "evil-plugin", "cubes", "evil-migration")
mkdirSync(evilPlugin4, { recursive: true })
writeFileSync(
  join(evilPlugin4, "index.ts"),
  EVIL_CUBE(`{ fromCube: "auth", toCube: "evil-migration", fromPlugin: "evil-plugin" }`),
)
const evil4 = await startServer(await freePort(), {
  QWBE_DATA_DIR: dataDir4,
  QWBE_MOUNTED: "account,settings,cli,evil-migration",
})
score.check(
  "ledger absent, victim unmounted: the source is refused, boot stops",
  !evil4.alive && evil4.output.includes("no record"),
  evil4.output.split("\n").find((l) => l.includes("record") || l.includes("igration")) ?? "(no error line)",
)
score.check(
  "auth.sqlite was NOT moved (ledger absent)",
  existsSync(join(dataDir4, "auth.sqlite")) && !existsSync(join(dataDir4, "evil-migration.sqlite")),
  "file untouched",
)
evil4.proc.kill()

// Attack 4b: the ledger is CORRUPT -- present but unreadable. A ledger that cannot be read is
// not an empty ledger: the boot stops on the corrupt file itself, before any migration check.
writeFileSync(join(dataDir4, "provenance.json"), "{ not json")
const evil4b = await startServer(await freePort(), {
  QWBE_DATA_DIR: dataDir4,
  QWBE_MOUNTED: "account,settings,cli,evil-migration",
})
score.check(
  "ledger corrupt: the boot stops on the corrupt ledger, not on a guess",
  !evil4b.alive && evil4b.output.includes("provenance ledger"),
  evil4b.output.split("\n").find((l) => l.includes("ledger")) ?? "(no error line)",
)
score.check(
  "auth.sqlite was NOT moved (ledger corrupt)",
  existsSync(join(dataDir4, "auth.sqlite")) && !existsSync(join(dataDir4, "evil-migration.sqlite")),
  "file untouched",
)
evil4b.proc.kill()
rmSync(join(coreDir, "plugins", "evil-plugin"), { recursive: true, force: true })
rmSync(dataDir4, { recursive: true, force: true })

// Attack 5: the plugin's TOP-LEVEL code rewrites the ledger at import time, before the mount
// checks run. The snapshot is taken before any import (main.ts), so the rewrite lands but the
// check reads the snapshot -- and the file stays.
const dataDir5 = join(tmpdir(), `qwbe-evil5-${process.pid}`)
mkdirSync(dataDir5, { recursive: true })
const authdb5 = new DatabaseSync(join(dataDir5, "auth.sqlite"))
authdb5.exec(
  `CREATE TABLE "sessions" (id TEXT PRIMARY KEY, type TEXT NOT NULL, createdAt TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL)`,
)
authdb5.close()
writeFileSync(join(dataDir5, "provenance.json"), JSON.stringify({ auth: null }, null, 2))
const evilPlugin5 = join(coreDir, "plugins", "evil-plugin", "cubes", "evil-migration")
mkdirSync(evilPlugin5, { recursive: true })
writeFileSync(
  join(evilPlugin5, "index.ts"),
  `import { writeFileSync } from "node:fs"
import { join } from "node:path"
// The attack: rewrite the ledger at import, claiming auth for this plugin.
writeFileSync(join(process.env.QWBE_DATA_DIR, "provenance.json"), JSON.stringify({ auth: "evil-plugin" }))
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
  QWBE_MOUNTED: "account,settings,cli,evil-migration",
})
score.check(
  "a plugin rewriting the ledger at import is caught by the pre-import snapshot",
  !evil5.alive && evil5.output.includes("ledger records"),
  evil5.output.split("\n").find((l) => l.includes("ledger") || l.includes("igration")) ?? "(no error line)",
)
score.check(
  "auth.sqlite was NOT moved (ledger rewritten at import)",
  existsSync(join(dataDir5, "auth.sqlite")) && !existsSync(join(dataDir5, "evil-migration.sqlite")),
  "file untouched",
)
evil5.proc.kill()
rmSync(join(coreDir, "plugins", "evil-plugin"), { recursive: true, force: true })
rmSync(dataDir5, { recursive: true, force: true })

process.exit(score.report("Booktags migration ledger probe"))
