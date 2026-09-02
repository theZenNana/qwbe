// The plugin's second cube, checked over HTTP: same rules as any cube, and the relation the
// space declares between it and bookmarks answers. The checks are the plugin half of the
// smoke run.

export const secondCubeAndRelation = async ({ api, score, H, bookmarkId, cubes }) => {
  const tag = await api.call("/tags", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ label: "docs", bookmarkId }),
  })
  score.check(
    "the plugin's second cube's routes work like any other",
    tag.status === 200 && !!tag.body.id,
    `id=${tag.body?.id}`,
  )

  const tagList = await api.call("/tags?limit=10", { headers: H })
  score.check(
    "the tag written is listed back",
    tagList.status === 200 && (tagList.body?.rows ?? []).some((r) => r.id === tag.body?.id),
    `http=${tagList.status}`,
  )

  const tagState = cubes.body?.find((c) => c.name === "booktags/tags")
  score.check(
    "the catalogue attributes the second cube to the same plugin, under the same parent",
    tagState?.plugin === "example-plugin" && tagState?.parent === "booktags",
    `plugin=${tagState?.plugin} parent=${tagState?.parent}`,
  )

  const bmLinks = await api.call(`/links/Bookmark/${bookmarkId}`, { headers: H })
  const tagGroup = await api.call(`/links/Bookmark/${bookmarkId}/booktags%2Ftags?limit=5`, { headers: H })
  score.check(
    "the Tag -> Bookmark relation answers from the space, declared by neither cube",
    bmLinks.status === 200 && tagGroup.status === 200 && (tagGroup.body?.rows ?? []).some((r) => r.id === tag.body?.id),
    `links http=${bmLinks.status} group http=${tagGroup.status} rows=${tagGroup.body?.rows?.length}`,
  )
}
