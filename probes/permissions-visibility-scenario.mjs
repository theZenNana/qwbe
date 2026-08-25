export const exerciseVisibility = async ({ api, post, score, admin, mihai, direct, id, ref, group }) => {
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
  const unhidden = await post(`${ref}/visibility`, mihai.headers, { hidden: false })
  const visibleAgain = await api.call(
    "/permissions/entities/notes?view=all&sortBy=createdAt&descending=true&offset=0&limit=10",
    { headers: mihai.headers },
  )
  const hiddenAfterUnhide = await api.call("/permissions/entities/notes?view=hidden-by-me&offset=0&limit=10", {
    headers: mihai.headers,
  })
  score.check(
    "Unhide restores default list and keeps provenance",
    unhidden.status === 200 &&
      visibleAgain.body?.total === 1 &&
      visibleAgain.body?.rows?.[0]?.access?.source === "user-grant" &&
      hiddenAfterUnhide.body?.total === 0,
  )

  const secondNote = await post("/notes", admin.headers, { title: "newest", body: "paging probe" })
  const newest = await api.call(
    "/permissions/entities/notes?view=all&sortBy=createdAt&descending=true&offset=0&limit=1",
    { headers: admin.headers },
  )
  const older = await api.call(
    "/permissions/entities/notes?view=all&sortBy=createdAt&descending=true&offset=1&limit=1",
    { headers: admin.headers },
  )
  score.check(
    "visibility paging and sort are server-side",
    secondNote.status === 200 &&
      newest.status === 200 &&
      newest.body?.total === 2 &&
      newest.body?.sortedBy === "createdAt" &&
      newest.body?.rows?.[0]?.entityId === secondNote.body?.id &&
      older.body?.rows?.[0]?.entityId === id,
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
  score.check("group cannot cross cube boundary", [400, 403, 404].includes(foreign.status), `http=${foreign.status}`)
}
