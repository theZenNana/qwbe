// Section 6 of the install-from probe: the directory-installed package's mounted life.
//
// Split out of `install-from.mjs` when that file crossed the 6000-character cap - the probe
// measures a system that grew, and the file measuring it grew with it. The seam is the one the
// section comments already drew: everything from "install once more" through the final
// uninstall lives here, returning verdicts instead of checking inline (the lifecycle pattern:
// a list of booleans keeps the score-collecting in one place).

import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { stopServer } from "./lib.mjs"
import { boot, pluginsDir } from "./lifecycle-bench.mjs"

/** Section 2b: between install and restart the drift must say "on disk, not mounted". */
export const driftSpeaks = async ({ api, admin }) => {
  const drift = await api.call("/settings/packages", { headers: admin })
  const offered = (drift.body ?? []).find((p) => p.name === "dirplugin")
  const cubesNow = await api.call("/settings/cubes", { headers: admin })
  return {
    name: "drift: the package shows installed but its cube is not mounted yet",
    ok: offered?.installed === true && !(cubesNow.body ?? []).some((c) => c.name === "dirbookmarks"),
    detail: `installed=${offered?.installed}`,
  }
}

/** Section 2c: the CLI adapter runs the same kernel function and speaks the same refusal. */
export const cliTwinSpeaks = async ({ api, admin }) => {
  const cli = await api.call("/cli/exec", {
    method: "POST",
    headers: admin,
    body: JSON.stringify({ line: "settings:install-from also/relative" }),
  })
  return {
    name: "CLI: the same refusal comes through the command adapter",
    ok: cli.status === 200 && String(cli.body?.output ?? cli.body?.message).includes("absolute"),
    detail: `http=${cli.status} out=${String(cli.body?.output ?? cli.body?.message).slice(0, 80)}`,
  }
}

/**
 * Sections 3-5: what uninstall owns, idempotence by fingerprint, and the repeated cycle.
 * Verdicts, not inline checks - same reason as mountedLife below.
 */
export const shelfAndCycles = async ({ api, admin, store, goodDir, rivalDir }) => {
  const verdicts = []
  const say = (name, ok, detail = "") => verdicts.push({ name, ok, detail })
  const post = (body) =>
    api.call("/settings/packages/install-from", { method: "POST", headers: admin, body: JSON.stringify(body) })
  const undo = () => api.call("/settings/packages/dirplugin", { method: "DELETE", headers: admin })

  // 3. Uninstall keeps the staged copy (the owner's decision on the ticket).
  const removed = await undo()
  say("uninstall of the package returns 200", removed.status === 200, `http=${removed.status}`)
  say("the installed plugin directory is gone", !existsSync(join(pluginsDir, "dirplugin")))
  say(
    "the staged copy STAYS in the store - reinstall must not need the source path",
    existsSync(join(store, "dirplugin", "qwbe-package.json")),
    "decision on the ticket: uninstall removes the install, not the shelf",
  )

  // 4. Idempotence by fingerprint, and the content guard.
  const again = await post({ path: goodDir })
  say(
    "same content staged again: reused, not refused (staged=false)",
    again.status === 200 && again.body?.staged === false,
    `http=${again.status} staged=${again.body?.staged}`,
  )
  await undo()

  const rival = await post({ path: rivalDir })
  say(
    "same name with DIFFERENT content is refused - the path proves nothing",
    rival.status === 400 && String(rival.body?.message).includes("different content"),
    `http=${rival.status}`,
  )

  // 5. remove -> add -> remove, through the door each time.
  const cycle1 = await post({ path: goodDir })
  const undo1 = await undo()
  const cycle2 = await post({ path: goodDir })
  const undo2 = await undo()
  say(
    "remove -> add -> remove twice: every step 200, disk clean at the end",
    cycle1.status === 200 &&
      undo1.status === 200 &&
      cycle2.status === 200 &&
      undo2.status === 200 &&
      !existsSync(join(pluginsDir, "dirplugin")),
    [cycle1, undo1, cycle2, undo2].map((r) => r.status).join(","),
  )
  return verdicts
}

export const mountedLife = async ({ dataDir, store, goodDir }) => {
  const verdicts = []
  const say = (name, ok, detail = "") => verdicts.push({ name, ok, detail })

  const second = await boot(dataDir, store)
  if (!second.server.alive) {
    say("restart after the cycles: server comes back", false, second.server.output.slice(0, 200))
    return verdicts
  }
  const session = await second.api.login()
  const add = await second.api.call("/settings/packages/install-from", {
    method: "POST",
    headers: session.headers,
    body: JSON.stringify({ path: goodDir }),
  })
  say("install once more, for the mounted-life check", add.status === 200, `http=${add.status}`)
  await stopServer(second.server)

  const third = await boot(dataDir, store)
  if (!third.server.alive) {
    say("restart with dirplugin on disk: server comes back", false, third.server.output.slice(0, 200))
    return verdicts
  }
  const s3 = await third.api.login()
  const made = await third.api.call("/dirbookmarks", {
    method: "POST",
    headers: s3.headers,
    body: JSON.stringify({ label: "Proba", url: "https://example.org/proba" }),
  })
  const list = await third.api.call("/dirbookmarks?limit=50", { headers: s3.headers })
  const found = (list.body?.rows ?? []).some((r) => r.id === made.body?.id && r.label === "Proba")
  say(
    "after restart the directory-installed cube is mounted and works - a row written and listed back",
    made.status === 200 && found,
    `create http=${made.status}, found=${found}`,
  )

  const gone = await third.api.call("/settings/packages/dirplugin", { method: "DELETE", headers: s3.headers })
  say("final uninstall leaves the live server answering", gone.status === 200, `http=${gone.status}`)

  // 6b. The source may disappear: with the shelf kept, install by name works from the store
  //     alone - the whole reason the shelf is kept (decision on the ticket).
  rmSync(goodDir, { recursive: true, force: true })
  const fromShelf = await third.api.call("/settings/packages/dirplugin/install", {
    method: "POST",
    headers: s3.headers,
  })
  const undoShelf = await third.api.call("/settings/packages/dirplugin", { method: "DELETE", headers: s3.headers })
  say(
    "source deleted after staging: install by name works from the kept shelf",
    fromShelf.status === 200 && undoShelf.status === 200,
    [fromShelf, undoShelf].map((r) => r.status).join(","),
  )
  await stopServer(third.server)
  return verdicts
}
