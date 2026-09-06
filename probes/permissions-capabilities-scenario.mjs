// QWB-63: runtime cube capability grants over HTTP, through the real mount wrapper. `notes`
// declares notes:read for admin+reader and notes:write for admin only, so a reader is the
// ordinary user the route gate stops; a grant of notes:write must open the route gate and
// leave the entity gate exactly where it was.
export const exerciseCapabilities = async ({
  api,
  post,
  score,
  admin,
  reader,
  readerName,
  other,
  otherName,
  noteId,
}) => {
  const draft = { title: "capability probe", body: "written by a grantee" }
  score.check(
    "ordinary reader is denied by the route gate",
    (await post("/notes", reader.headers, draft)).status === 403,
  )
  score.check(
    "reader cannot grant a cube capability",
    (await post("/permissions/capabilities/user", reader.headers, { capability: "notes:write", username: otherName }))
      .status === 403,
  )
  score.check(
    "undeclared capability is a 400",
    (await post("/permissions/capabilities/user", admin.headers, { capability: "notes:purge", username: readerName }))
      .status === 400,
  )
  const granted = await post("/permissions/capabilities/user", admin.headers, {
    capability: "notes:write",
    username: readerName,
  })
  const me = await api.call("/auth/me", { headers: reader.headers })
  score.check(
    "grant reports in /auth/me on the next request of the same session",
    granted.status === 200 &&
      me.body?.permissions?.includes("notes:write") &&
      !me.body?.permissions?.includes("permissions:write"),
  )
  const created = await post("/notes", reader.headers, draft)
  score.check("cube write grant opens the route gate", created.status === 200)
  score.check(
    "cube write does not open another user's entity",
    (await api.call(`/notes/${noteId}`, { headers: reader.headers })).status === 403,
  )
  score.check(
    "unrelated user stays denied by the route gate",
    (await post("/notes", other.headers, draft)).status === 403,
  )
  const listed = await api.call("/permissions/capabilities?cube=notes", { headers: admin.headers })
  score.check(
    "capability grants list is manager-only",
    listed.status === 200 &&
      listed.body?.length === 1 &&
      (await api.call("/permissions/capabilities?cube=notes", { headers: reader.headers })).status === 403,
  )
  const revoked = await api.call(`/permissions/capabilities/${granted.body?.id}`, {
    method: "DELETE",
    headers: admin.headers,
  })
  score.check(
    "revoke is effective on the next request of the same session, role read stays",
    revoked.status === 200 &&
      (await post("/notes", reader.headers, draft)).status === 403 &&
      (await api.call(`/notes/${created.body?.id}`, { headers: reader.headers })).status === 200,
  )
  const group = await post("/permissions/groups", admin.headers, { cube: "notes", name: "Writers" })
  await post(`/permissions/groups/${group.body?.id}/members`, admin.headers, { username: otherName })
  const crossed = await post("/permissions/capabilities/group", admin.headers, {
    capability: "permissions:read",
    groupId: group.body?.id,
  })
  score.check("group of another cube is rejected", crossed.status === 400)
  const viaGroup = await post("/permissions/capabilities/group", admin.headers, {
    capability: "notes:write",
    groupId: group.body?.id,
  })
  score.check(
    "group grant opens the route gate for members",
    viaGroup.status === 200 && (await post("/notes", other.headers, draft)).status === 200,
  )
  await post(`/permissions/groups/${group.body?.id}/members/remove`, admin.headers, { username: otherName })
  score.check(
    "group removal closes it on the next request",
    (await post("/notes", other.headers, draft)).status === 403,
  )
  score.check(
    "audit records the capability lifecycle",
    (await api.call("/permissions/audit?action=capability.revoke", { headers: admin.headers })).body?.total === 1,
  )
}
