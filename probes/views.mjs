// QWB-62 kernel stage: the views cube under REAL auth, on a scratch server on a free port.
//
// Proves the structural guarantees of the design:
//   - private by default: another user lists and reads nothing (kernel entity enforcement);
//   - a read grant carries no edit, no delete, and no right to re-share;
//   - ownership is CANONICAL (the permissions record): after a transfer the old owner loses
//     access -- no denormalized ownerId exists to go stale;
//   - the config trust boundary is a 400 on the wire;
//   - targetCube is immutable on update;
//   - no results route exists (a view can never execute or proxy target-cube data), and the
//     cube's source imports nothing from any other cube (no CRM name anywhere).

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { client, dropScratch, freePort, makeScore, root, scratchDataDir, startServer, stopServer } from "./lib.mjs"

const port = await freePort()
const data = scratchDataDir("views")
const score = makeScore()
const api = client(port)
const post = (path, headers, body) => api.call(path, { method: "POST", headers, body: JSON.stringify(body) })
const patch = (path, headers, body) => api.call(path, { method: "PATCH", headers, body: JSON.stringify(body) })

// ponytail: the working tree carries the crm-pack plugin, whose legacy `contacts` table
// needs an explicit operator authorization on ANY fresh data dir -- same pattern as
// probes/booktags.mjs. Scratch dir only; nothing here touches a real database.
const server = await startServer(port, {
  QWBE_DATA_DIR: data,
  QWBE_LEGACY_MIGRATIONS:
    "contacts:crm-pack,contracts:crm-pack,crm/accounts:crm-pack,bookmarks:example-plugin,tags:example-plugin",
})
if (!server.alive) {
  dropScratch(data)
  console.error(`server did not start:\n${server.output}`)
  process.exit(1)
}

try {
  const admin = await api.login()
  score.check("admin logs in on the scratch server", admin.status === 200)
  for (const [username, password] of [
    ["ana", "ana-pass"],
    ["bogdan", "bogdan-pass"],
  ]) {
    const created = await post("/account", admin.headers, { username, password, roles: ["reader"] })
    score.check(`reader account ${username} created`, created.status === 200)
  }
  const ana = await api.login("ana", "ana-pass")
  const bogdan = await api.login("bogdan", "bogdan-pass")

  const made = await post("/views", ana.headers, {
    targetCube: "crm/organizations",
    name: "Open orgs",
    config: { columns: ["name"], filters: { status: "open" }, pageSize: 50 },
  })
  score.check("ana creates her own view", made.status === 200)
  const id = made.body?.id
  score.check(
    "the stored config is re-encoded JSON, not the raw payload",
    typeof made.body?.config === "string" && JSON.parse(made.body.config).pageSize === 50,
  )

  const listed = await api.call("/views", { headers: bogdan.headers })
  score.check("bogdan lists no views: private by default", listed.status === 200 && listed.body?.total === 0)
  score.check(
    "bogdan cannot read ana's view",
    (await api.call(`/views/${id}`, { headers: bogdan.headers })).status === 403,
  )

  const grant = await post(`/permissions/entities/views/SavedView/${encodeURIComponent(id)}/grants/user`, ana.headers, {
    username: "bogdan",
    actions: ["read"],
  })
  score.check("ana shares the view with bogdan (read only)", grant.status === 200)
  const shared = await api.call("/views", { headers: bogdan.headers })
  score.check("bogdan now sees the shared view in his list", shared.status === 200 && shared.body?.total === 1)
  score.check(
    "bogdan can read the shared view",
    (await api.call(`/views/${id}`, { headers: bogdan.headers })).status === 200,
  )

  score.check(
    "a read grant is not edit",
    (await patch(`/views/${id}`, bogdan.headers, { name: "Hijacked" })).status === 403,
  )
  score.check(
    "a read grant is not delete",
    (await api.call(`/views/${id}`, { method: "DELETE", headers: bogdan.headers })).status === 403,
  )
  const reshare = await post(
    `/permissions/entities/views/SavedView/${encodeURIComponent(id)}/grants/user`,
    bogdan.headers,
    {
      username: "admin",
      actions: ["read"],
    },
  )
  score.check("a grantee cannot re-share", reshare.status === 403)

  for (const [label, payload, path] of [
    ["unknown top-level key", { name: "v", config: { grouping: true } }, null],
    ["reserved filter key", { config: { filters: { page: "2" } } }, null],
    ["pageSize out of bounds", { config: { pageSize: 999 } }, null],
    ["empty name", { name: "   " }, null],
    ["targetCube in a PATCH payload", { name: "Moved", targetCube: "crm/contacts" }, `/views/${id}`],
    ["bad targetCube on create", { targetCube: "has spaces", name: "v", config: {} }, null],
  ]) {
    const url = path ?? "/views"
    const r = path ? await patch(url, ana.headers, payload) : await post(url, ana.headers, payload)
    score.check(`invalid write rejected with 400: ${label}`, r.status === 400)
  }

  const transfer = await post(`/permissions/entities/views/SavedView/${encodeURIComponent(id)}/owner`, ana.headers, {
    username: "bogdan",
  })
  score.check("ana transfers ownership through the existing route", transfer.status === 200)
  score.check(
    "the old owner loses access immediately (canonical ownership, no stale ownerId)",
    (await api.call(`/views/${id}`, { headers: ana.headers })).status === 403,
  )
  score.check(
    "the new owner can edit",
    (await patch(`/views/${id}`, bogdan.headers, { name: "Now mine" })).status === 200,
  )

  const openapi = await api.call("/openapi.json", { headers: admin.headers })
  const viewPaths = Object.keys(openapi.body?.paths ?? {}).filter((p) => p.startsWith("/views"))
  score.check(
    "exactly the five view routes are published",
    JSON.stringify(viewPaths.sort()) === JSON.stringify(["/views", "/views/{id}"]) &&
      Object.keys(openapi.body.paths["/views"]).sort().join(",") === "get,post" &&
      Object.keys(openapi.body.paths["/views/{id}"]).sort().join(",") === "delete,get,patch",
  )
  score.check(
    "no results route exists: a view never executes target-cube data",
    !viewPaths.some((p) => p.includes("results")),
  )

  const sources = readdirSync(join(root, "core", "src", "cubes", "views")).map((f) =>
    readFileSync(join(root, "core", "src", "cubes", "views", f), "utf8"),
  )
  score.check(
    "the views cube imports no other cube and names no CRM (decoupling)",
    !sources.some((s) => /crm|cubes\/(?!views)/.test(s.replace(/\/\/[^\n]*/g, ""))),
  )
} finally {
  await stopServer(server)
  dropScratch(data)
}

process.exit(score.exit())
