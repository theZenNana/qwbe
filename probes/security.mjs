// Attacks on this prototype's own claims. Written while two adversarial reviews were in
// flight, on the principle that the claim you are least sure of is the one to shoot at first.
//
//   node probes/security.mjs
//
// Everything here tries to BREAK something the README asserts. A passing check means the
// attack failed, which is the outcome we want — but the attack has to be real, not a
// demonstration of the happy path.
//
// Adding this file does not disturb the invariant probe: that one fingerprints `core/` only,
// and this lives in `probes/`.
//
// The file outgrew its size cap, so the sections live in four modules beside it. This one keeps
// the running order, the two shortest sections, and the server everybody shares:
//
//   security-injection.mjs   1, 1b, 1c, 1d — the query string, and what must not come back
//   security-cli.mjs         3             — the CLI gate
//   security-boundaries.mjs  4, 6          — who may do what, and what "switched off" means
//   security-manifest.mjs    7, 8          — manifests that lie, checked at mount, not over HTTP

import { client, dropScratch, freePort, makeScore, scratchDataDir, startServer, stopServer } from "./lib.mjs"
import { disabledCubeIsGone, permissionBoundaries } from "./security-boundaries.mjs"
import { theCliGate } from "./security-cli.mjs"
import { injectionAndLeaks } from "./security-injection.mjs"
import { manifestLies, tableOwnership } from "./security-manifest.mjs"

// This probe used to hardcode port 4507 — so did `install` and `customfields`. Running two of
// them at once produced EADDRINUSE, which reads as broken code to whoever sees it next.
const PORT = await freePort()
const dataDir = scratchDataDir("security")
const score = makeScore()
const api = client(PORT)

const server = await startServer(PORT, { QWBE_DATA_DIR: dataDir })
if (!server.alive) {
  console.error(`server did not start:\n${server.output}`)
  process.exit(1)
}

try {
  const session = await api.login()
  const H = session.headers

  await api.call("/notes", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ title: "target", body: "row that must survive every attack below" }),
  })

  // ============ 1, 1b, 1c, 1d. SQL, leaks, ordering, capabilities ============
  await injectionAndLeaks({ api, score, H })

  // ============ 2. paging bounds ============
  const negative = await api.call("/notes?limit=-5&offset=-10", { headers: H })
  score.check(
    "paging: negative limit and offset are normalised, not passed through",
    negative.status === 200 && negative.body?.limit >= 1 && negative.body?.offset === 0,
    `limit=${negative.body?.limit} offset=${negative.body?.offset}`,
  )

  const huge = await api.call("/notes?limit=99999999999999999999", { headers: H })
  score.check(
    "paging: an absurd limit is capped, not honoured",
    huge.status === 200 && huge.body?.limit <= 200,
    `limit=${huge.body?.limit}`,
  )

  const fractional = await api.call("/notes?limit=2.7&offset=1.9", { headers: H })
  score.check(
    "paging: fractional values are truncated to integers",
    fractional.status === 200 && Number.isInteger(fractional.body?.limit),
    `limit=${fractional.body?.limit} offset=${fractional.body?.offset}`,
  )

  // ============ 3. the CLI gate ============
  await theCliGate({ api, score, H })

  // ============ 4. permission boundaries, per caller ============
  await permissionBoundaries({ api, score })

  // ============ 5. tokens ============
  const forged = await api.call("/auth/me", { headers: { authorization: `Bearer ${"a".repeat(43)}` } })
  score.check("tokens: a forged token of the right shape is rejected", forged.status === 401, `http=${forged.status}`)

  const empty = await api.call("/auth/me", { headers: { authorization: "Bearer " } })
  score.check("tokens: an empty bearer is rejected", empty.status === 401, `http=${empty.status}`)

  const noScheme = await api.call("/auth/me", { headers: { authorization: session.token } })
  score.check(
    "tokens: the raw token without the Bearer scheme is rejected",
    noScheme.status === 401,
    `http=${noScheme.status}`,
  )

  // ============ 6. a disabled cube is really gone ============
  await disabledCubeIsGone({ api, score, H })

  // ============ 7. manifest lies ============
  await manifestLies({ score })

  // ============ 8. table ownership ============
  await tableOwnership({ score })
} finally {
  await stopServer(server)
  dropScratch(dataDir)
}

process.exit(score.report("Security probe"))
