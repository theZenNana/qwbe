// What a successful install actually does, and how it is taken back.
//
// The second half is the one worth reading. The pair install / `DELETE /settings/cubes/{name}`
// looked complete until the gap was walked into: installing does not MOUNT, and that route takes
// a MOUNTED cube. So a package installed a minute ago — by accident, say — could not be taken
// back without first restarting to mount the very thing you wanted gone.
//
// Leaves the tree as it found it plus `probecube` and `probeplugin`, which the caller's `finally`
// removes; the undo section reinstalls the plugin on purpose, so the checks after it see the tree
// they expect.

import { existsSync } from "node:fs"
import { join } from "node:path"

export const installWorks = async ({ api, score, admin, planted, plantedPlugin }) => {
  const ok = await api.call("/settings/packages/probecube/install", { method: "POST", headers: admin.headers })
  score.check("install: a valid package installs — 200", ok.status === 200, `http=${ok.status}`)
  score.check("install: the directory is on disk", existsSync(planted))
  score.check(
    "install: the store's bookkeeping file is NOT copied into the cube",
    existsSync(planted) && !existsSync(join(planted, "qwbe-package.json")),
    "a file the cube never declared has no business inside it",
  )
  score.check(
    "install: the response says a restart is needed rather than pretending it is mounted",
    ok.body?.requiresRestart === true,
    "the kernel reads the disk at startup; a response that claimed otherwise would be a lie",
  )

  const mountedNow = await api.call("/settings/cubes", { headers: admin.headers })
  score.check(
    "install: and it is indeed NOT mounted yet — the claim matches reality",
    !(mountedNow.body ?? []).some((c) => c.name === "probecube"),
    "checked, because `requiresRestart: true` is only honest if the cube really is absent",
  )

  const again = await api.call("/settings/packages/probecube/install", { method: "POST", headers: admin.headers })
  score.check(
    "install: installing over an existing directory is refused, not merged",
    again.status === 400,
    `http=${again.status} — merging would touch existing files, which is the one thing the invariant forbids`,
  )

  const pluginOk = await api.call("/settings/packages/probeplugin/install", { method: "POST", headers: admin.headers })
  score.check("install: a plugin lands in the plugins directory", pluginOk.status === 200 && existsSync(plantedPlugin))
}

export const undoBeforeRestart = async ({ api, score, admin, reader, plantedPlugin }) => {
  const notMounted = await api.call("/settings/cubes", { headers: admin.headers })
  score.check(
    "undo: the freshly installed plugin is on disk and NOT mounted — the state the gap lived in",
    existsSync(plantedPlugin) && !(notMounted.body ?? []).some((c) => c.name === "probeplugincube"),
  )

  const undoAnon = await api.call("/settings/packages/probeplugin", { method: "DELETE" })
  score.check(
    "undo: it is not open to anyone — no token is refused",
    undoAnon.status === 401,
    `http=${undoAnon.status}`,
  )

  const undoReader = await api.call("/settings/packages/probeplugin", { method: "DELETE", headers: reader.headers })
  score.check("undo: a reader cannot undo an install", undoReader.status === 403, `http=${undoReader.status}`)

  const undo = await api.call("/settings/packages/probeplugin", { method: "DELETE", headers: admin.headers })
  score.check("undo: an unmounted package CAN be taken back — 200", undo.status === 200, `http=${undo.status}`)
  score.check("undo: its directory is gone", !existsSync(plantedPlugin))
  score.check(
    "undo: undoing twice is refused, not silently fine",
    (await api.call("/settings/packages/probeplugin", { method: "DELETE", headers: admin.headers })).status === 400,
  )

  // Put it back, so the checks after this one see the tree they expect.
  await api.call("/settings/packages/probeplugin/install", { method: "POST", headers: admin.headers })

  const unknown = await api.call("/settings/packages/nosuchpackage/install", { method: "POST", headers: admin.headers })
  score.check("install: an unknown package is refused", unknown.status === 400, `http=${unknown.status}`)
}

/**
 * Two packages bringing the same cube name.
 *
 * The real store contains `crm-pack` and `erp-pack`, which both bring a cube called
 * `contacts`. Installing the second was accepted, and the NEXT STARTUP died — the kernel refuses
 * duplicate cube names, correctly. From a button in a web page, "the server will not come up" is
 * the worst way to find out, and nothing connects the click to the failure. Reproduced here
 * before fixing, and kept so it cannot come back.
 */
export const nameCollisionIsRefused = async ({ api, score, admin, pluginsDir }) => {
  const rival = await api.call("/settings/packages/rivalplugin/install", { method: "POST", headers: admin.headers })
  score.check(
    "collision: a package bringing a cube name already on disk is REFUSED at install time",
    rival.status === 400,
    `http=${rival.status} — the alternative is a server that refuses to start`,
  )
  score.check(
    "collision: the refusal names the cube and where the other one came from",
    typeof rival.body?.message === "string" &&
      rival.body.message.includes("probeplugincube") &&
      rival.body.message.includes("probeplugin"),
    String(rival.body?.message ?? "").slice(0, 120),
  )
  score.check("collision: nothing was written for the refused package", !existsSync(join(pluginsDir, "rivalplugin")))

  const listedAgain = await api.call("/settings/packages", { headers: admin.headers })
  const rivalInfo = (listedAgain.body ?? []).find((p) => p.name === "rivalplugin")
  score.check(
    "collision: the listing PUBLISHES the clash, so a client can refuse before the click",
    Array.isArray(rivalInfo?.conflicts) && rivalInfo.conflicts.includes("probeplugincube"),
    `conflicts=${JSON.stringify(rivalInfo?.conflicts)}`,
  )
  const cleanOne = (listedAgain.body ?? []).find((p) => p.name === "probecube")
  score.check(
    "collision: a package that clashes with nothing reports an empty list, not a missing field",
    Array.isArray(cleanOne?.conflicts) && cleanOne.conflicts.length === 0,
    `conflicts=${JSON.stringify(cleanOne?.conflicts)}`,
  )
}
