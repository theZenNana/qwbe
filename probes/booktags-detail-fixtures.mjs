const post = (api, headers, path, body) => api.call(path, { method: "POST", headers, body: JSON.stringify(body) })

export const detailBehaviour = async ({ api, score, adminHeaders, readerHeaders, guestHeaders }) => {
  const bad = await post(api, adminHeaders, "/bookmarks", { label: "x", targetCube: "nosuchcube" })
  score.check("a bookmark pointing at no mounted cube is refused", bad.status === 400, `http=${bad.status}`)
  const bookmark = await post(api, adminHeaders, "/bookmarks", { label: "notes", targetCube: "notes" })
  score.check("a bookmark pointing at a real cube is accepted", bookmark.status === 200, `id=${bookmark.body?.id}`)

  const detail = await api.call(`/bookmarks/${bookmark.body.id}`, { headers: adminHeaders })
  score.check(
    "an existing bookmark has a typed detail route",
    detail.status === 200 && detail.body?.id === bookmark.body.id,
    `http=${detail.status}`,
  )
  const missing = await api.call("/bookmarks/bm-missing", { headers: adminHeaders })
  score.check(
    "a missing bookmark returns semantic 404",
    missing.status === 404 && missing.body?.message === "bookmark bm-missing does not exist",
    `http=${missing.status} message=${missing.body?.message}`,
  )
  const unauthenticated = await api.call(`/bookmarks/${bookmark.body.id}`)
  score.check(
    "bookmark detail requires authentication",
    unauthenticated.status === 401,
    `http=${unauthenticated.status}`,
  )
  const reader = await api.call(`/bookmarks/${bookmark.body.id}`, { headers: readerHeaders })
  score.check(
    "a reader without an entity grant cannot open another user's bookmark",
    reader.status === 403 && reader.body?.needed === "booktags/bookmarks:entity",
    `http=${reader.status} needed=${reader.body?.needed}`,
  )
  const forbidden = await api.call(`/bookmarks/${bookmark.body.id}`, { headers: guestHeaders })
  score.check(
    "an authenticated role without entity access is refused",
    forbidden.status === 403 && forbidden.body?.needed === "booktags/bookmarks:entity",
    `http=${forbidden.status} needed=${forbidden.body?.needed}`,
  )

  const tag = await post(api, adminHeaders, "/tags", { label: "important", bookmarkId: bookmark.body.id })
  const tagDetail = await api.call(`/tags/${tag.body.id}`, { headers: adminHeaders })
  score.check(
    "an existing related tag has a typed detail route",
    tag.status === 200 && tagDetail.status === 200 && tagDetail.body?.bookmarkId === bookmark.body.id,
    `create=${tag.status} detail=${tagDetail.status}`,
  )
  const missingTag = await api.call("/tags/tag-missing", { headers: adminHeaders })
  score.check(
    "a missing tag returns semantic 404",
    missingTag.status === 404 && missingTag.body?.message === "tag tag-missing does not exist",
    `http=${missingTag.status} message=${missingTag.body?.message}`,
  )
}
