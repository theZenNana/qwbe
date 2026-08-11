// The whole life of the planted plugin, start to finish, in one function that can be run twice.
//
// It returns a list of VERDICTS instead of checking as it goes, and that is the whole design:
// the point is to run it twice and compare the two lists. A step that passes on the first run
// and passes for a different reason on the second is not deterministic, and a list of booleans
// makes that visible where a green tick would not.
//
// The package under test is a renamed copy of example-plugin, planted in a temp store by
// lifecycle-bench.mjs. The steps are the ones the crm-pack version walked until QWB-13:
// install does not mount, restart mounts, the cube works, uninstall does not crash the live
// server, restart removes.

import { existsSync } from "node:fs"
import { join } from "node:path"
import { dropScratch, scratchDataDir, stopServer } from "./lib.mjs"
import { boot, PKG, PKG_CUBE, pluginsDir } from "./lifecycle-bench.mjs"

export const liveAndDie = async (pass, store) => {
  const dataDir = scratchDataDir(`qwbe-lifecycle-${pass}`)
  const verdicts = []
  const say = (name, ok, detail = "") => {
    verdicts.push({ name, ok, detail })
    return ok
  }

  try {
    // 1. A clean start: the package is on offer, its cube is nowhere.
    let { server, api } = await boot(dataDir, store)
    if (!server.alive) return [{ name: `pass ${pass}: server starts`, ok: false, detail: server.output.slice(0, 200) }]
    let session = await api.login()
    say(`pass ${pass}: clean start - login works`, session.status === 200, `http=${session.status}`)

    let cubes = await api.call("/settings/cubes", { headers: session.headers })
    const namesBefore = (cubes.body ?? []).map((c) => c.name)
    say(
      `pass ${pass}: before install - ${PKG_CUBE} is not mounted`,
      !namesBefore.includes(PKG_CUBE),
      `mounted: ${namesBefore.join(", ")}`,
    )

    const gone = await api.call(`/${PKG_CUBE}`, { headers: session.headers })
    say(`pass ${pass}: before install - /${PKG_CUBE} is a 404`, gone.status === 404, `http=${gone.status}`)

    // 2. Install. It writes to disk and says so; it must NOT mount.
    const installed = await api.call(`/settings/packages/${PKG}/install`, {
      method: "POST",
      headers: session.headers,
    })
    say(
      `pass ${pass}: install returns 200 and asks for a restart`,
      installed.status === 200 && installed.body?.requiresRestart === true,
      `http=${installed.status} requiresRestart=${installed.body?.requiresRestart}`,
    )
    say(
      `pass ${pass}: install put the plugin on disk`,
      existsSync(join(pluginsDir, PKG, "cubes", PKG_CUBE)),
      `core/plugins/${PKG}/cubes/${PKG_CUBE}`,
    )

    const stillGone = await api.call(`/${PKG_CUBE}`, { headers: session.headers })
    say(
      `pass ${pass}: install did NOT mount - /${PKG_CUBE} still 404 in the running server`,
      stillGone.status === 404,
      `http=${stillGone.status} - the restart banner is telling the truth`,
    )

    // 3. Restart. Now it mounts - and it works, which is a different claim.
    await stopServer(server)
    ;({ server, api } = await boot(dataDir, store))
    if (!server.alive)
      return [...verdicts, { name: `pass ${pass}: restart`, ok: false, detail: server.output.slice(0, 200) }]
    session = await api.login()

    cubes = await api.call("/settings/cubes", { headers: session.headers })
    const namesAfter = (cubes.body ?? []).map((c) => c.name)
    say(
      `pass ${pass}: after restart - the package's cube is mounted`,
      namesAfter.includes(PKG_CUBE),
      `mounted: ${namesAfter.join(", ")}`,
    )

    const made = await api.call(`/${PKG_CUBE}`, {
      method: "POST",
      headers: session.headers,
      // The cube is a copy of booktags' bookmarks child: a bookmark points at a real cube.
      body: JSON.stringify({ label: "Proba", targetCube: "notes", url: "https://example.org/proba" }),
    })
    const list = await api.call(`/${PKG_CUBE}?limit=50`, { headers: session.headers })
    const found = (list.body?.rows ?? []).some((r) => r.id === made.body?.id && r.label === "Proba")
    say(
      `pass ${pass}: the installed cube actually works - a row written and listed back`,
      made.status === 200 && list.status === 200 && found,
      `create http=${made.status}, list http=${list.status}, found=${found}`,
    )

    // 4. Uninstall while it is mounted. The running server must not be damaged by it.
    const removed = await api.call(`/settings/packages/${PKG}`, { method: "DELETE", headers: session.headers })
    say(
      `pass ${pass}: uninstall returns 200 and asks for a restart`,
      removed.status === 200 && removed.body?.requiresRestart === true,
      `http=${removed.status}`,
    )
    say(
      `pass ${pass}: uninstall took the directory off disk`,
      !existsSync(join(pluginsDir, PKG)),
      `core/plugins/${PKG} gone`,
    )

    const zombie = await api.call(`/${PKG_CUBE}`, { headers: session.headers })
    say(
      `pass ${pass}: the already-mounted routes keep answering until the restart`,
      zombie.status === 200,
      `http=${zombie.status} - deleting files under a live server must not break it mid-request`,
    )

    // 5. Restart. Gone must mean "404", not "the application is down".
    await stopServer(server)
    ;({ server, api } = await boot(dataDir, store))
    say(
      `pass ${pass}: the application still starts after the package was removed`,
      server.alive,
      server.alive ? "" : server.output.slice(0, 200),
    )
    if (!server.alive) return verdicts

    session = await api.login()
    say(`pass ${pass}: login still works with the package gone`, session.status === 200, `http=${session.status}`)

    const after = await api.call(`/${PKG_CUBE}`, { headers: session.headers })
    say(`pass ${pass}: /${PKG_CUBE} is a 404 again, not a crash`, after.status === 404, `http=${after.status}`)

    cubes = await api.call("/settings/cubes", { headers: session.headers })
    const namesEnd = (cubes.body ?? []).map((c) => c.name)
    say(
      `pass ${pass}: the catalogue answers and no longer lists the removed cube`,
      cubes.status === 200 && !namesEnd.includes(PKG_CUBE),
      `http=${cubes.status}, mounted: ${namesEnd.join(", ")}`,
    )

    await stopServer(server)
    return verdicts
  } finally {
    dropScratch(dataDir)
  }
}
