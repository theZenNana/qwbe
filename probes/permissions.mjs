import { client, dropScratch, freePort, makeScore, scratchDataDir, startServer, stopServer } from "./lib.mjs"

const port = await freePort()
const data = scratchDataDir("permissions")
const score = makeScore()
const api = client(port)
const server = await startServer(port, { QWBE_DATA_DIR: data })

if (!server.alive) {
  dropScratch(data)
  console.error(`server did not start:\n${server.output}`)
  process.exit(1)
}

const post = (path, headers, body) => api.call(path, { method: "POST", headers, body: JSON.stringify(body) })

try {
  const anonymous = await api.call("/permissions/audit")
  score.check("anonymous permissions request is 401", anonymous.status === 401)

  const admin = await api.login()
  for (const [username, password] of [
    ["mihai", "mihai-pass"],
    ["ioana", "ioana-pass"],
    ["cuby", "cuby-pass"],
  ]) {
    const created = await post("/account", admin.headers, { username, password, roles: ["reader"] })
    score.check(`account ${username} created`, created.status === 200)
  }
  const mihai = await api.login("mihai", "mihai-pass")
  const ioana = await api.login("ioana", "ioana-pass")
  const cuby = await api.login("cuby", "cuby-pass")

  const note = await post("/notes", admin.headers, { title: "private", body: "permission probe" })
  score.check("entity creator becomes owner", note.status === 200)
  const id = note.body?.id
  const ref = `/permissions/entities/notes/Note/${encodeURIComponent(id)}`
  const assigned = await post("/permissions/cube-admins", admin.headers, { cube: "notes", username: "cuby" })
  score.check(
    "cube admin is limited to assigned cube",
    assigned.status === 200 &&
      (await api.call(`/notes/${id}`, { headers: cuby.headers })).status === 200 &&
      (await api.call("/permissions/groups?cube=crm%2Fcontacts", { headers: cuby.headers })).status === 403,
  )
  score.check(
    "unrelated users receive 403",
    (await api.call(`/notes/${id}`, { headers: mihai.headers })).status === 403,
  )

  const direct = await post(`${ref}/grants/user`, admin.headers, { username: "mihai" })
  score.check("@username defaults to TOTAL", direct.status === 200 && direct.body?.actions?.length === 6)
  score.check("direct grant permits read", (await api.call(`/notes/${id}`, { headers: mihai.headers })).status === 200)
  score.check(
    "second user remains isolated",
    (await api.call(`/notes/${id}`, { headers: ioana.headers })).status === 403,
  )

  const group = await post("/permissions/groups", admin.headers, { cube: "notes", name: "Sales" })
  await post(`/permissions/groups/${group.body?.id}/members`, admin.headers, { username: "ioana" })
  const groupGrant = await post(`${ref}/grants/group`, admin.headers, { groupId: group.body?.id, actions: ["read"] })
  score.check(
    "group READ permits read",
    groupGrant.status === 200 && (await api.call(`/notes/${id}`, { headers: ioana.headers })).status === 200,
  )

  const hidden = await post(`${ref}/visibility`, mihai.headers, { hidden: true })
  const normal = await api.call("/permissions/entities/notes?view=all&offset=0&limit=10", { headers: mihai.headers })
  score.check("Hide is personal and removes default listing", hidden.status === 200 && normal.body?.total === 0)

  const revoked = await api.call(`/permissions/grants/${direct.body?.id}`, { method: "DELETE", headers: admin.headers })
  score.check(
    "revoke removes access immediately",
    revoked.status === 200 && (await api.call(`/notes/${id}`, { headers: mihai.headers })).status === 403,
  )
  await post(`${ref}/grants/user`, admin.headers, { username: "mihai" })
  const hiddenAgain = await api.call("/permissions/entities/notes?view=hidden-by-me&offset=0&limit=10", {
    headers: mihai.headers,
  })
  score.check(
    "regrant preserves personal hidden preference",
    hiddenAgain.status === 200 && hiddenAgain.body?.total === 1,
  )

  const transfer = await post(`${ref}/owner`, admin.headers, { username: "mihai" })
  score.check(
    "ownership transfer preserves creator",
    transfer.status === 200 && transfer.body?.ownerId !== transfer.body?.createdBy,
  )
  const audit = await api.call("/permissions/audit?action=ownership.transfer&offset=0&limit=1", {
    headers: admin.headers,
  })
  score.check(
    "audit is filtered and paginated with trace",
    audit.status === 200 && audit.body?.total === 1 && audit.body?.rows?.[0]?.traceId,
  )

  const foreign = await post("/permissions/entities/tags/Tag/tag-x/grants/group", admin.headers, {
    groupId: group.body?.id,
    actions: ["read"],
  })
  score.check("group cannot cross cube boundary", foreign.status === 403)
} finally {
  await stopServer(server)
  dropScratch(data)
}

process.exitCode = score.report("Permissions E2E probe")
