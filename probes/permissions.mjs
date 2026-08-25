import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { client, dropScratch, freePort, makeScore, root, scratchDataDir, startServer, stopServer } from "./lib.mjs"
import { exercisePermissionBypass } from "./permissions-bypass-scenario.mjs"
import { exerciseVisibility } from "./permissions-visibility-scenario.mjs"

const port = await freePort()
const data = scratchDataDir("permissions")
const store = mkdtempSync(join(tmpdir(), "permissions-store-"))
const fixture = join(root, "probes", "fixtures", "permission-bypass")
const installedFixture = join(root, "core", "plugins", "permission-bypass")
const score = makeScore()
const api = client(port)
if (existsSync(installedFixture)) {
  console.error(`refused: ${installedFixture} already exists and was not planted by this probe`)
  process.exit(1)
}
let server = await startServer(port, { QWBE_DATA_DIR: data, QWBE_STORE_DIR: store })

if (!server.alive) {
  dropScratch(data)
  console.error(`server did not start:\n${server.output}`)
  process.exit(1)
}

const post = (path, headers, body) => api.call(path, { method: "POST", headers, body: JSON.stringify(body) })

try {
  const installer = await api.login()
  const installed = await post("/settings/packages/install-from", installer.headers, { path: fixture })
  score.check("adversarial plugin installs through install-from", installed.status === 200)
  await stopServer(server)
  server = await startServer(port, { QWBE_DATA_DIR: data, QWBE_STORE_DIR: store })
  if (!server.alive) throw new Error(`server did not restart with adversarial plugin:\n${server.output}`)

  const anonymous = await api.call("/permissions/audit")
  score.check("anonymous permissions request is 401", anonymous.status === 401)

  const admin = await api.login()
  for (const [username, password] of [
    ["mihai", "mihai-pass"],
    ["ioana", "ioana-pass"],
    ["cuby", "cuby-pass"],
    ["doru", "doru-pass"],
  ]) {
    const created = await post("/account", admin.headers, { username, password, roles: ["reader"] })
    score.check(`account ${username} created`, created.status === 200)
  }
  const mihai = await api.login("mihai", "mihai-pass")
  const ioana = await api.login("ioana", "ioana-pass")
  const cuby = await api.login("cuby", "cuby-pass")
  const doru = await api.login("doru", "doru-pass")

  await exercisePermissionBypass({ api, post, score, admin, outsider: mihai, server })

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
  const revokedAdmin = await api.call("/permissions/cube-admins/notes/cuby", {
    method: "DELETE",
    headers: admin.headers,
  })
  score.check(
    "revoked cube admin loses access after persisted revoke",
    revokedAdmin.status === 200 &&
      (await api.call(`/notes/${id}`, { headers: cuby.headers })).status === 403 &&
      (await api.call("/permissions/audit?action=cube-admin.revoke", { headers: admin.headers })).body?.total === 1,
  )
  score.check(
    "unrelated users receive 403",
    (await api.call(`/notes/${id}`, { headers: mihai.headers })).status === 403,
  )

  const direct = await post(`${ref}/grants/user`, admin.headers, { username: "mihai" })
  score.check("@username defaults to TOTAL", direct.status === 200 && direct.body?.actions?.length === 6)
  score.check("direct grant permits read", (await api.call(`/notes/${id}`, { headers: mihai.headers })).status === 200)
  score.check(
    "TOTAL grantee cannot manage grants",
    (await api.call(`${ref}/grants?offset=0&limit=10`, { headers: mihai.headers })).status === 403,
  )
  score.check(
    "second user remains isolated",
    (await api.call(`/notes/${id}`, { headers: ioana.headers })).status === 403,
  )

  const custom = await post(`${ref}/grants/user`, admin.headers, {
    username: "doru",
    actions: ["read", "edit"],
  })
  score.check(
    "custom user grant preserves exact actions",
    custom.status === 200 && JSON.stringify(custom.body?.actions) === JSON.stringify(["read", "edit"]),
  )
  const grants = await api.call(`${ref}/grants?offset=0&limit=1`, { headers: admin.headers })
  score.check(
    "grant list is server-paged",
    grants.status === 200 && grants.body?.limit === 1 && grants.body?.total === 2 && grants.body?.rows?.length === 1,
  )
  const customRevoked = await api.call(`/permissions/grants/${custom.body?.id}`, {
    method: "DELETE",
    headers: admin.headers,
  })
  score.check(
    "custom grant revoke removes access",
    customRevoked.status === 200 && (await api.call(`/notes/${id}`, { headers: doru.headers })).status === 403,
  )

  const group = await post("/permissions/groups", admin.headers, { cube: "notes", name: "Sales" })
  await post(`/permissions/groups/${group.body?.id}/members`, admin.headers, { username: "ioana" })
  const groupGrant = await post(`${ref}/grants/group`, admin.headers, { groupId: group.body?.id, actions: ["read"] })
  score.check(
    "group READ permits read",
    groupGrant.status === 200 && (await api.call(`/notes/${id}`, { headers: ioana.headers })).status === 200,
  )

  await exerciseVisibility({ api, post, score, admin, mihai, direct, id, ref, group })
} finally {
  await stopServer(server)
  rmSync(installedFixture, { recursive: true, force: true })
  rmSync(store, { recursive: true, force: true })
  dropScratch(data)
}

process.exitCode = score.report("Permissions E2E probe")
