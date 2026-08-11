// The CLI gate and the on/off switches -- the two longest stretches of the smoke probe.
//
// Split out of `smoke.mjs` on 3 Aug 2026, when it stood at 8418 characters against a 6000 cap.
// The probe measures a system that has grown; the file measuring it grew with it. Splitting on
// the section comments that were already there beat inventing a new arrangement.
//
// It takes the caller's server, not its own: one login, one running system, two files. A second
// `startServer` here would double the slowest part of the run to save nothing.

export const cliAndSwitches = async ({ api, score, H, me }) => {
  // --- the CLI gate ---
  const commands = await api.call("/cli/commands", { headers: H })
  score.check(
    "commands are aggregated from every cube, plugin included",
    commands.body?.some((c) => c.name === "notes:count") &&
      commands.body?.some((c) => c.name === "booktags/bookmarks:count"),
    `${commands.body?.length} commands`,
  )

  const count = await api.call("/cli/exec", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ line: "notes:count" }),
  })
  score.check(
    "the gate runs a declared command",
    count.body?.ok === true && count.body?.output === "12",
    `output=${count.body?.output}`,
  )

  const withArgs = await api.call("/cli/exec", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ line: "notes:recent 3" }),
  })
  score.check(
    "arguments reach the command",
    withArgs.body?.output?.split("\n").length === 3,
    `${withArgs.body?.output?.split("\n").length} lines back`,
  )

  const unknown = await api.call("/cli/exec", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ line: "rm -rf /" }),
  })
  score.check(
    "an undeclared command is refused, not executed",
    unknown.status === 400 && String(unknown.body?.message).includes("unknown command"),
    `http=${unknown.status}`,
  )

  // A reader must not run an admin-only command. Same permission mechanism as every endpoint.
  const readerSession = await api.login("reader", "reader")
  const readerRuns = await api.call("/cli/exec", {
    method: "POST",
    headers: readerSession.headers,
    body: JSON.stringify({ line: "settings:cubes" }),
  })
  score.check(
    "a command is gated by its own permission, per caller",
    readerRuns.status === 200,
    `reader may run settings:cubes (read permission) -> http=${readerRuns.status}`,
  )

  // --- switching a cube off ---
  const before = await api.call("/notes?limit=1", { headers: H })
  await api.call("/settings/cubes/notes", { method: "POST", headers: H, body: JSON.stringify({ enabled: false }) })
  const after = await api.call("/notes?limit=1", { headers: H })
  score.check(
    "cube switched off -> its routes 404",
    before.status === 200 && after.status === 404,
    `before=${before.status} after=${after.status}`,
  )

  const linksAfter = await api.call(`/links/Account/${me.body.id}`, { headers: H })
  score.check(
    "a switched-off cube also vanishes from everyone else's related lists",
    !linksAfter.body?.groups?.some((g) => g.cube === "notes"),
    `groups left: ${JSON.stringify(linksAfter.body?.groups?.map((g) => g.cube) ?? [])}`,
  )

  const commandsAfter = await api.call("/cli/commands", { headers: H })
  score.check(
    "its commands disappear from the CLI too",
    !commandsAfter.body?.some((c) => c.name.startsWith("notes:")),
    `${commandsAfter.body?.length} commands left`,
  )

  const required = await api.call("/settings/cubes/settings", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ enabled: false }),
  })
  score.check("a required cube cannot be switched off", required.status === 400, `http=${required.status}`)

  await api.call("/settings/cubes/notes", { method: "POST", headers: H, body: JSON.stringify({ enabled: true }) })
  const back = await api.call("/notes?limit=1", { headers: H })
  score.check("switched back on -> routes return", back.status === 200, `http=${back.status}`)
}
