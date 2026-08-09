// The ERP probe — the `erp-pack` plugin, exercised over HTTP against a server this file starts.
//
//   node probes/erp.mjs
//
// It checks three separate things, and they are worth naming because only the first is ordinary:
//
//   1. BEHAVIOUR - accounts and contacts support list, create, read,
//      change, page, and point a person at a company.
//   2. THE SETTINGS ACTUALLY DO SOMETHING — the ERP's own settings cube is not a page of dead
//      values. Change a prefix, create a record, and the number changes. A setting nobody reads
//      is decoration, and decoration in a settings screen is a lie.
//   3. THE DECOUPLING — `contacts` does not name the entity it points at, and neither cube
//      imports the other. Checked by reading the files, the way `probes/decoupling.mjs` does,
//      because a passing HTTP call proves nothing about who knows whom.

import { execFileSync } from "node:child_process"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { accountsBehave } from "./erp-accounts.mjs"
import { contactsAndTheLink } from "./erp-contacts.mjs"
import { settingsDoSomething } from "./erp-settings-probe.mjs"
import { theSurfaceAround } from "./erp-surface.mjs"
import {
  client,
  coreDir,
  dropScratch,
  freePort,
  makeScore,
  root,
  scratchDataDir,
  startServer,
  stopServer,
} from "./lib.mjs"

const PORT = await freePort()
const score = makeScore()
const api = client(PORT)

// A directory of its own instead of `<root>/data` plus a list of files to delete. The list was
// the problem: it had to name every database this probe might inherit, and it stopped being
// complete the moment a cube was added. An empty directory has nothing to keep up to date.
const dataDir = scratchDataDir("erp")

// THE PACK HAS TO BE INSTALLED, AND crm-pack HAS TO STEP ASIDE FOR IT.
//
// `core/store/` is a shelf; `core/plugins/` is what the kernel reads, once, at startup. This
// probe used to start a server and then read `core/plugins/erp-pack/` — a directory nothing had
// put there. Worse, it crashed rather than failing: `("title" in (body ?? {}))` on a body that
// was the empty string, so the run ended in a TypeError instead of a score.
//
// And erp-pack cannot simply be installed: it brings a cube called `contacts`, and so does
// crm-pack, which IS mounted. The kernel refuses that at install time on purpose — see
// probes/install.mjs, "a package bringing a cube name already on disk is REFUSED". So crm-pack
// comes out first and goes back in at the end, restored from git rather than reinstalled: git
// has the exact bytes that are committed, an install only has bytes that are equivalent.
const PACK = "erp-pack"
const RIVAL = "crm-pack"
const installedAt = join(coreDir, "plugins", PACK)
const rivalAt = join(coreDir, "plugins", RIVAL)

const restoreRival = () => {
  rmSync(installedAt, { recursive: true, force: true })
  execFileSync("git", ["checkout", "--", rivalAt], { cwd: root })
}

let server = await startServer(PORT, { QWBE_DATA_DIR: dataDir })
if (!server.alive) {
  console.error(`server did not start:\n${server.output}`)
  process.exit(1)
}

{
  const admin = await api.login()
  const bail = async (why) => {
    console.error(why)
    await stopServer(server)
    restoreRival()
    dropScratch(dataDir)
    process.exit(1)
  }

  const removed = await api.call(`/settings/packages/${RIVAL}`, { method: "DELETE", headers: admin.headers })
  if (removed.status !== 200) await bail(`could not remove ${RIVAL}: http=${removed.status}`)
  await stopServer(server)
  server = await startServer(PORT, { QWBE_DATA_DIR: dataDir })

  const admin2 = await api.login()
  const installed = await api.call(`/settings/packages/${PACK}/install`, { method: "POST", headers: admin2.headers })
  if (installed.status !== 200) await bail(`could not install ${PACK}: http=${installed.status}`)
  await stopServer(server)
  server = await startServer(PORT, { QWBE_DATA_DIR: dataDir })
  if (!server.alive) await bail(`server did not restart after installing ${PACK}:\n${server.output}`)
}

try {
  const session = await api.login()
  const H = session.headers
  score.check("login → token", session.status === 200 && !!session.token, `http=${session.status}`)

  // --- the three cubes are mounted, and the catalogue says which plugin brought them ---
  const cubes = (await api.call("/settings/cubes", { headers: H })).body
  const brought = ["accounts", "contacts", "erp-settings"].map((n) => cubes?.find((c) => c.name === n))
  score.check(
    "the plugin's three cubes mount in the same namespace as core's",
    brought.every((c) => c?.plugin === "erp-pack" && c.system === false && c.enabled),
    brought.map((c) => `${c?.name}:${c?.plugin}`).join(" "),
  )
  score.check(
    "`accounts` is a different cube from core's `account`, with its own entity",
    cubes?.find((c) => c.name === "accounts")?.entity === "ErpAccount" &&
      cubes?.find((c) => c.name === "account")?.entity === "Account",
    "ErpAccount ≠ Account — a company is not a user",
  )

  // The four sections below are in four files beside this one. The ORDER is not cosmetic: the
  // settings section creates rows, and the paging checks after it assert the totals those rows
  // produce. Reordering them would make the same assertions mean something else.
  const { accountId } = await accountsBehave({ api, score, H })
  const { contactId } = await contactsAndTheLink({ api, score, H, accountId })
  await settingsDoSomething({ api, score, H })
  await theSurfaceAround({ api, score, H, contactId })
} finally {
  await stopServer(server)
  // erp-pack out, crm-pack back exactly as committed. A probe that leaves the plugins directory
  // rearranged hands the next person a repo whose `git status` blames them.
  restoreRival()
  dropScratch(dataDir)
}

process.exit(score.report("ERP probe — erp-pack"))
