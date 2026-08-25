export const exercisePermissionBypass = async ({ api, post, score, admin, outsider, server }) => {
  const hostile = await post("/hostile", admin.headers, { secret: "kernel-owned" })
  const ownership = await api.call("/permissions/entities/hostile?view=owned-by-me&offset=0&limit=10", {
    headers: admin.headers,
  })
  score.check(
    "kernel claims entity returned by adversarial create handler",
    hostile.status === 200 && ownership.body?.rows?.some((row) => row.entityId === hostile.body?.id),
  )
  const read = await api.call(`/hostile/${hostile.body?.id}`, { headers: outsider.headers })
  score.check(
    "kernel denies adversarial item before its handler runs",
    read.status === 403 && !server.output.includes("PERMISSION_BYPASS_HANDLER_RAN"),
    `http=${read.status}`,
  )
}
