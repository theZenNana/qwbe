// End-to-end probe: login through logout, across every cube.
//
//   node probes/smoke.mjs

import { join } from "node:path"
import { client, dropScratch, freePort, makeScore, root, scratchDataDir, startServer, stopServer } from "./lib.mjs"
import { cliAndSwitches } from "./smoke-cli.mjs"
import { secondCubeAndRelation } from "./smoke-tags.mjs"

// A port the OS says is free and a databases directory of its own: this probe used to share
// both with every other probe and with the owner's running server. See `lib.mjs`.
const PORT = await freePort()
const dataDir = scratchDataDir("smoke")
const score = makeScore()
const api = client(PORT)

const server = await startServer(PORT, { QWBE_DATA_DIR: dataDir })
if (!server.alive) {
  console.error(`server did not start:\n${server.output}`)
  process.exit(1)
}

try {
  // --- authentication ---
  const wrong = await api.call("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "wrong" }),
  })
  score.check("wrong password -> 401", wrong.status === 401, `http=${wrong.status}`)

  const session = await api.login()
  score.check("login -> token", session.status === 200 && !!session.token, `http=${session.status}`)
  score.check(
    "token is opaque, not a JWT",
    !String(session.token).includes("."),
    `"${String(session.token).slice(0, 12)}..."`,
  )
  const H = session.headers

  const noToken = await api.call("/notes")
  score.check("no token -> 401", noToken.status === 401, `http=${noToken.status}`)

  const me = await api.call("/auth/me", { headers: H })
  score.check("/auth/me -> admin", me.body?.username === "admin", `roles=${JSON.stringify(me.body?.roles)}`)

  // Permissions come from every cube's manifest, including the plugin's - not from a map
  // written inside auth. The plugin's cubes are children of `booktags` now, so the
  // permission carries the compound prefix.
  score.check(
    "permissions aggregated from all manifests, plugin included",
    me.body?.permissions?.includes("notes:read") && me.body?.permissions?.includes("booktags/bookmarks:read"),
    `${me.body?.permissions?.length} permissions`,
  )

  // auth reads the user through the registry; it never opens the account cube's database.
  const accounts = await api.call("/account?limit=5", { headers: H })
  score.check(
    "auth and account are separate cubes, joined only through the registry",
    accounts.status === 200 && accounts.body.total === 2,
    `${accounts.body?.total} accounts seeded`,
  )
  score.check(
    "the password hash never leaves the account cube over HTTP",
    !JSON.stringify(accounts.body).includes("passwordHash"),
    "no passwordHash in the /account response",
  )

  // --- data and real SQL paging ---
  for (let i = 1; i <= 12; i++) {
    await api.call("/notes", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ title: `Note ${String(i).padStart(2, "0")}`, body: `body of note ${i}` }),
    })
  }

  const firstPage = await api.call("/notes?limit=10", { headers: H })
  score.check(
    "paging is in the contract: limit=10 returns 10 rows but total=12",
    firstPage.body?.rows?.length === 10 && firstPage.body?.total === 12,
    `rows=${firstPage.body?.rows?.length} total=${firstPage.body?.total}`,
  )

  const capped = await api.call("/notes?limit=999999", { headers: H })
  score.check("limit is hard-capped at 200", capped.body?.limit === 200, `asked 999999, got ${capped.body?.limit}`)

  const sorted = await api.call("/notes?limit=1&sortBy=title&descending=true", { headers: H })
  score.check(
    "sorting happens in SQL, over a JSON field",
    sorted.body?.rows?.[0]?.title === "Note 12",
    `first row = ${sorted.body?.rows?.[0]?.title}`,
  )

  // --- the link declared in a space, by neither cube ---
  const links = await api.call(`/links/Account/${me.body.id}`, { headers: H })
  const noteGroup = links.body?.groups?.find((g) => g.cube === "notes")
  score.check(
    "the space's link shows up as a group with a total, without fetching rows",
    noteGroup?.total === 12 && !("rows" in (noteGroup ?? {})),
    `group "${noteGroup?.label}" total=${noteGroup?.total}`,
  )

  const groupPage = await api.call(`/links/Account/${me.body.id}/notes?limit=5`, { headers: H })
  score.check(
    "a group's rows are paged",
    groupPage.body?.rows?.length === 5 && groupPage.body?.total === 12,
    `rows=${groupPage.body?.rows?.length} of ${groupPage.body?.total}`,
  )

  // --- the plugin cube behaves like any other -- now as a CHILD of booktags ---
  const bm = await api.call("/bookmarks", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ label: "Effect docs", targetCube: "notes", url: "https://effect.website" }),
  })
  score.check("a plugin cube's routes work like any other", bm.status === 200 && !!bm.body.id, `id=${bm.body?.id}`)

  const cubes = await api.call("/settings/cubes", { headers: H })
  const bmState = cubes.body?.find((c) => c.name === "booktags/bookmarks")
  score.check(
    "the catalogue says which plugin brought a cube, and which parent owns it",
    bmState?.plugin === "example-plugin" && bmState?.system === false && bmState?.parent === "booktags",
    `plugin=${bmState?.plugin} system=${bmState?.system} parent=${bmState?.parent}`,
  )

  // --- the plugin's second cube and the space-declared relation (split out: file cap) ---
  await secondCubeAndRelation({ api, score, H, bookmarkId: bm.body.id, cubes })

  await cliAndSwitches({ api, score, H, me })

  // --- store isolation, proven on the factory itself ---
  const { storeFor } = await import(join(root, "core/src/kernel/store.ts"))
  const { Effect } = await import(join(root, "core/node_modules/effect/dist/esm/index.js"))
  let threw = false
  let errorName = ""
  try {
    // Lazy: the Effect must actually be RUN for the throw to happen. Running it is the point -
    // otherwise the probe would pass without testing anything.
    Effect.runSync(storeFor("notes", ["notes"]).all("accounts"))
  } catch (e) {
    threw = true
    errorName = String(e?.cause?.constructor?.name ?? e?.constructor?.name ?? "")
    if (!errorName.includes("ForeignTable") && String(e).includes("ForeignTable")) errorName = "ForeignTableError"
  }
  score.check(
    "a cube cannot open another cube's table",
    threw && errorName === "ForeignTableError",
    threw ? `threw ${errorName}` : "did NOT throw - isolation is broken",
  )

  // --- logout ---
  await api.call("/auth/logout", { method: "POST", headers: H })
  const afterLogout = await api.call("/auth/me", { headers: H })
  score.check("after logout the same token gives 401", afterLogout.status === 401, `http=${afterLogout.status}`)
} finally {
  await stopServer(server)
  dropScratch(dataDir)
}

process.exit(score.report("Smoke probe"))
