// The runtime-hierarchy probe: Booktags as a parent with three owned children.
//
//   node probes/booktags.mjs
//
// Covers what smoke.mjs does not: discovery of a parent and its children, the parent mask
// on the switches, the settings child changing a sibling's behaviour over the bus, the
// data-file migration from the flat cubes, and a restart keeping all of it true.
// The design these checks serve: docs/booktags-hierarchy.md. The fixture and the behaviour
// sequence live in booktags-fixtures.mjs (file cap).

import { hierarchyBehaviour, migratedSchemas, plantLegacyBookmarks } from "./booktags-fixtures.mjs"
import { client, dropDatabase, freePort, makeScore, scratchDatabase, startServer, stopServer } from "./lib.mjs"

const PORT = await freePort()
const dbUrl = await scratchDatabase("booktags")
const score = makeScore()
const api = client(PORT)

// The planted schema is PRE-LEDGER history: no provenance.json exists, so the migration needs
// the operator's explicit authorization -- exactly the path a real pre-ledger upgrade takes.
await plantLegacyBookmarks(dbUrl)

// The planted file is PRE-LEDGER history: no provenance.json exists, so the migration needs
// the operator's explicit authorization -- exactly the path a real pre-ledger upgrade takes.
const server = await startServer(PORT, {
  QWBE_DATABASE_URL: dbUrl,
  QWBE_LEGACY_MIGRATIONS: "bookmarks:example-plugin,tags:example-plugin",
})
if (!server.alive) {
  console.error(`server did not start:\n${server.output}`)
  process.exit(1)
}

try {
  const session = await api.login()
  const H = session.headers
  const reader = await api.login("reader", "reader")
  await api.call("/account", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ username: "guest", password: "guest", roles: ["guest"] }),
  })
  const guest = await api.login("guest", "guest")

  // --- discovery and catalogue ---
  const cubes = (await api.call("/settings/cubes", { headers: H })).body ?? []
  const names = cubes.map((c) => c.name)
  score.check(
    "the kernel mounts the parent and its three children",
    ["booktags", "booktags/bookmarks", "booktags/tags", "booktags/settings"].every((n) => names.includes(n)),
    names.filter((n) => n.includes("booktags")).join(", "),
  )
  score.check(
    "children carry their parent in the catalogue; standalone cubes do not",
    cubes.find((c) => c.name === "booktags/bookmarks")?.parent === "booktags" &&
      cubes.find((c) => c.name === "notes")?.parent === null,
    "parent field checked",
  )
  score.check(
    "notes is unchanged: standalone, no parent, own prefix",
    cubes.find((c) => c.name === "notes")?.prefix === "notes",
    "notes still the standalone example",
  )
  score.check(
    "the child whose leaf name collides with core `settings` serves under <parent>-<name>",
    cubes.find((c) => c.name === "booktags/settings")?.prefix === "booktags-settings",
    `prefix=${cubes.find((c) => c.name === "booktags/settings")?.prefix}`,
  )
  score.check(
    "a non-cube directory next to the children (assets/, no index.ts) is ignored, not imported",
    server.alive && !names.includes("booktags/assets"),
    "server booted, assets not in the catalogue",
  )

  // --- migration of the flat cube's data ---
  score.check(
    "the flat bookmarks schema was renamed to the child's schema",
    await migratedSchemas(dbUrl),
    "old gone, new present",
  )
  const legacy = await api.call("/bookmarks?limit=10", { headers: H })
  score.check(
    "the legacy row survived the move and decodes under the new schema",
    legacy.status === 200 && (legacy.body?.rows ?? []).some((r) => r.id === "bm-legacy01"),
    `http=${legacy.status} rows=${legacy.body?.rows?.length}`,
  )

  await hierarchyBehaviour({ api, score, H, readerHeaders: reader.headers, guestHeaders: guest.headers })
} finally {
  await stopServer(server)
}

// --- restart: everything above is still true after a fresh boot ---
const server2 = await startServer(PORT, { QWBE_DATABASE_URL: dbUrl })
try {
  if (!server2.alive) throw new Error(`second boot failed:\n${server2.output}`)
  const session = await api.login()
  const H = session.headers
  const legacy = await api.call("/bookmarks?limit=10", { headers: H })
  score.check(
    "after a restart the migrated data is still served",
    legacy.status === 200 &&
      (legacy.body?.rows ?? []).some((r) => r.id === "bm-legacy01") &&
      (await migratedSchemas(dbUrl)),
    `http=${legacy.status}`,
  )
  const strictStill = await api.call("/bookmarks", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ label: "y", targetCube: "notes", url: "https://x" }),
  })
  score.check("the strict setting survived the restart", strictStill.status === 400, `http=${strictStill.status}`)
  const children = await api.call("/cli/exec", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ line: "booktags:children" }),
  })
  score.check(
    "the parent's own command lists its children",
    children.body?.ok === true && String(children.body?.output).includes("booktags/bookmarks"),
    `output=${JSON.stringify(children.body?.output)}`,
  )
} finally {
  await stopServer(server2)
  await dropDatabase(dbUrl)
}

process.exit(score.report("Booktags hierarchy probe"))
