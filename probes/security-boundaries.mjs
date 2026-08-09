// Sections 4 and 6: who may do what, and what "switched off" means.
//
// Both are about a boundary being real rather than declared — one per caller, one per cube.
// They are exported separately so the caller keeps the original order, with the token checks
// still sitting between them.

export const permissionBoundaries = async ({ api, score }) => {
  const reader = await api.login("reader", "reader")
  const readerWrites = await api.call("/notes", {
    method: "POST",
    headers: reader.headers,
    body: JSON.stringify({ title: "should not exist", body: "" }),
  })
  // This check used to assert the OPPOSITE — that a reader creating a note succeeds — on the
  // grounds that the manifest granted `notes:write` to reader and the mechanism was only
  // required to report honestly. That was the wrong thing to freeze into a probe.
  //
  // Found while verifying a newly installed cube: a `reader` could create tasks. The reflex was
  // to blame the new cube, but it had copied `notes` faithfully, and `notes` had granted
  // `notes:write` to reader from the start. So had `bookmarks`. Only `account:write` and
  // `settings:write` were admin-only — the cubes holding actual content all handed writes to
  // the role whose entire name says it reads.
  //
  // It is policy rather than a hole in the mechanism: permission checks worked exactly as
  // written, and enforced a grant that should not have existed. But a probe that asserts the
  // wrong policy is worse than no probe — it defends the mistake against the next person who
  // notices it.
  score.check(
    "permissions: a reader cannot write, whatever the cube",
    readerWrites.status === 403,
    `reader creating a note → http=${readerWrites.status}`,
  )

  // The check above tests one cube. This one tests the RULE, so the next cube to arrive cannot
  // reintroduce the grant quietly — which is exactly how it got in: copied from the example.
  const readerMe = await api.call("/auth/me", { headers: reader.headers })
  const readerWritePerms = (readerMe.body?.permissions ?? []).filter((p) => p.endsWith(":write"))
  score.check(
    "permissions: no cube anywhere grants a write permission to reader",
    readerWritePerms.length === 0,
    readerWritePerms.length ? `granted: ${readerWritePerms.join(", ")}` : "checked across every mounted manifest",
  )

  const readerAdmin = await api.call("/settings/cubes/notes", {
    method: "POST",
    headers: reader.headers,
    body: JSON.stringify({ enabled: false }),
  })
  score.check(
    "permissions: reader cannot switch a cube off (settings:write is admin-only)",
    readerAdmin.status === 403,
    `http=${readerAdmin.status}`,
  )

  const readerAdminViaCli = await api.call("/cli/exec", {
    method: "POST",
    headers: reader.headers,
    body: JSON.stringify({ line: "account:list" }),
  })
  score.check(
    "permissions: the CLI gate applies the same rules as the HTTP routes",
    readerAdminViaCli.status === 200,
    `account:read is granted to reader → http=${readerAdminViaCli.status}, same answer as the route`,
  )
}

export const disabledCubeIsGone = async ({ api, score, H }) => {
  await api.call("/settings/cubes/notes", { method: "POST", headers: H, body: JSON.stringify({ enabled: false }) })

  const disabledRoute = await api.call("/notes?limit=1", { headers: H })
  score.check("disabled: its routes are gone", disabledRoute.status === 404, `http=${disabledRoute.status}`)

  // Without a token, a disabled cube and a non-existent one must look identical — otherwise the
  // 404 body answers "which cubes exist here" to anyone who asks.
  const anonDisabled = await api.call("/notes")
  const anonMissing = await api.call("/nosuchcube")
  score.check(
    "disabled: unauthenticated, a switched-off cube is indistinguishable from a missing one",
    JSON.stringify(anonDisabled.body) === JSON.stringify(anonMissing.body),
    `off: ${JSON.stringify(anonDisabled.body).slice(0, 50)} · missing: ${JSON.stringify(anonMissing.body).slice(0, 50)}`,
  )

  const disabledCommand = await api.call("/cli/exec", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ line: "notes:count" }),
  })
  score.check(
    "disabled: its commands cannot be run through the gate either",
    disabledCommand.status === 400,
    `http=${disabledCommand.status} — the command is not in the registry while the cube is off`,
  )

  const disabledLinks = await api.call("/links", { headers: H })
  score.check(
    "disabled: its entity disappears from the registry",
    !(disabledLinks.body ?? []).some((e) => e.cube === "notes"),
    `entities left: ${JSON.stringify((disabledLinks.body ?? []).map((e) => e.cube))}`,
  )

  // Switched back on, because everything after this one expects the tree it started with.
  await api.call("/settings/cubes/notes", { method: "POST", headers: H, body: JSON.stringify({ enabled: true }) })
}
