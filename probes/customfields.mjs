// The CUSTOM FIELDS probe — fields added to another cube at runtime, checked over HTTP.
//
//   node probes/customfields.mjs
//
// Three things, and the first is the reason the design looks the way it does:
//
//   1. THE MEASUREMENT THE DESIGN RESTS ON. A key a cube does not declare is silently dropped on
//      the way in — no error, no value. So custom values cannot live in the target's own row,
//      and this probe re-measures it rather than trusting a note in a document.
//   2. VALIDATION IS STRICT. Because the values live with the definitions, the cube that owns
//      the definition owns the write: types, options, and required are all enforced at the API,
//      not in a form.
//   3. NOTHING IS HALF-APPLIED. A write with one bad value stores none of the good ones.

import { rmSync } from "node:fs"
import { join } from "node:path"
import { definingFields } from "./customfields-define.mjs"
import { changingAndSurface } from "./customfields-surface.mjs"
import { writingValues } from "./customfields-values.mjs"
import { client, dropScratch, freePort, makeScore, root, scratchDataDir, startServer, stopServer } from "./lib.mjs"

const PORT = await freePort()
const score = makeScore()
const api = client(PORT)

// Its own empty directory rather than a regex over `<root>/data`. The regex had to list every
// database a re-run might inherit — a list that goes stale the next time a cube is added.
const dataDir = scratchDataDir("customfields")

// THE PACK HAS TO BE INSTALLED FIRST, AND THE SERVER RESTARTED. `core/store/` is a shelf;
// `core/plugins/` is what the kernel reads, once, at startup. Installing copies one to the other
// and answers `requiresRestart: true` — which is the honest answer, so the probe honours it.
//
// Without this the probe asked a server started before the pack existed for the pack's routes,
// got 404 on all of them, and reported 35 failures that said "the pack is broken" when what was
// broken was the probe's own setup. A red that blames the wrong thing is worse than no red.
const PACK = "customfields-pack"
const installedAt = join(root, "core", "plugins", PACK)

let server = await startServer(PORT, { QWBE_DATA_DIR: dataDir })
if (!server.alive) {
  console.error(`server did not start:\n${server.output}`)
  process.exit(1)
}

{
  const admin = await api.login()
  const installed = await api.call(`/settings/packages/${PACK}/install`, {
    method: "POST",
    headers: admin.headers,
  })
  if (installed.status !== 200) {
    console.error(`could not install ${PACK}: http=${installed.status} ${JSON.stringify(installed.body)}`)
    await stopServer(server)
    dropScratch(dataDir)
    process.exit(1)
  }
  await stopServer(server)
  server = await startServer(PORT, { QWBE_DATA_DIR: dataDir })
  if (!server.alive) {
    console.error(`server did not restart after installing ${PACK}:\n${server.output}`)
    rmSync(installedAt, { recursive: true, force: true })
    dropScratch(dataDir)
    process.exit(1)
  }
}

const define = (body, headers) => api.call("/customfields", { method: "POST", headers, body: JSON.stringify(body) })
const setValues = (cube, rowId, values, headers) =>
  api.call(`/customfields/values/${cube}/${rowId}`, { method: "PUT", headers, body: JSON.stringify({ values }) })

try {
  const session = await api.login()
  const H = session.headers
  score.check("login → token", session.status === 200 && !!session.token, `http=${session.status}`)

  // --- 1. the measurement the whole design rests on ---
  //
  // `name`, not `lastName`: TWO packs ship a cube called `contacts` — crm-pack's has `name`,
  // erp-pack's has `lastName` — and which one answers depends on what is installed. This asked
  // with erp-pack's field while crm-pack's cube was mounted, so it got 400 for a MISSING REQUIRED
  // FIELD and reported it as "the extra key was refused". The check was right; the request was
  // addressed to a cube that was not there.
  const withExtra = await api.call("/contacts", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ name: "Probă", cnp: "synthetic-cnp-extra" }),
  })
  score.check(
    "a key the target cube does not declare is DROPPED, not refused — so values cannot live in its row",
    withExtra.status === 200 && !("cnp" in (withExtra.body ?? {})),
    `http=${withExtra.status}, cnp in row: ${"cnp" in (withExtra.body ?? {})}`,
  )
  const contactId = withExtra.body?.id

  // Sections 2 to 10 are in three files beside this one. The order is the probe: section 4
  // writes the values that section 10 proves survive a cube being switched off and back on.
  const { seniority, birthday } = await definingFields({ api, score, H, define, contactId })
  await writingValues({ api, score, H, setValues, contactId })
  await changingAndSurface({ api, score, H, define, setValues, contactId, seniority, birthday })
} finally {
  await stopServer(server)
  // The install wrote into the repo's own plugins directory, so it comes back out — otherwise a
  // probe leaves `untracked` red and the next person inherits a mount nobody asked for.
  rmSync(installedAt, { recursive: true, force: true })
  dropScratch(dataDir)
}

process.exit(score.report("Custom fields probe — customfields-pack"))
