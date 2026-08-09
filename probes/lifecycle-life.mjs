// The whole life of `crm-pack`, start to finish, in one function that can be run twice.
//
// It returns a list of VERDICTS instead of checking as it goes, and that is the whole design:
// the point is to run it twice and compare the two lists. A step that passes on the first run
// and passes for a different reason on the second is not deterministic, and a list of booleans
// makes that visible where a green tick would not.

import { existsSync } from "node:fs"
import { join } from "node:path"
import { dropScratch, scratchDataDir, stopServer } from "./lib.mjs"
import { boot, cubesOf, pluginsDir } from "./lifecycle-bench.mjs"

export const liveAndDie = async (pass) => {
  const dataDir = scratchDataDir(`qwbe-lifecycle-${pass}`)
  const verdicts = []
  const say = (name, ok, detail = "") => {
    verdicts.push({ name, ok, detail })
    return ok
  }

  try {
    // 1. A clean start: the package is on offer, its cubes are nowhere.
    let { server, api } = await boot(dataDir)
    if (!server.alive) return [{ name: `pass ${pass}: server starts`, ok: false, detail: server.output.slice(0, 200) }]
    let session = await api.login()
    say(`pass ${pass}: clean start — login works`, session.status === 200, `http=${session.status}`)

    let cubes = await api.call("/settings/cubes", { headers: session.headers })
    const namesBefore = (cubes.body ?? []).map((c) => c.name)
    say(
      `pass ${pass}: before install — contacts and contracts are not mounted`,
      !namesBefore.includes("contacts") && !namesBefore.includes("contracts"),
      `mounted: ${namesBefore.join(", ")}`,
    )

    const gone = await api.call("/contacts", { headers: session.headers })
    say(`pass ${pass}: before install — /contacts is a 404`, gone.status === 404, `http=${gone.status}`)

    // 2. Install. It writes to disk and says so; it must NOT mount.
    const installed = await api.call("/settings/packages/crm-pack/install", {
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
      existsSync(join(pluginsDir, "crm-pack", "cubes", "contacts")),
      "core/plugins/crm-pack/cubes/contacts",
    )

    const stillGone = await api.call("/contacts", { headers: session.headers })
    say(
      `pass ${pass}: install did NOT mount — /contacts still 404 in the running server`,
      stillGone.status === 404,
      `http=${stillGone.status} — the restart banner is telling the truth`,
    )

    // 3. CRM and ERP both carry `contacts`. The second one must be refused, by name.
    const clash = await api.call("/settings/packages/erp-pack/install", { method: "POST", headers: session.headers })
    const message = String(clash.body?.message ?? clash.body ?? "")
    say(
      `pass ${pass}: ERP is refused because CRM already brought "contacts"`,
      clash.status === 400 && message.includes("contacts"),
      `http=${clash.status} — ${message.slice(0, 90)}`,
    )
    say(
      `pass ${pass}: the refused install left CRM alone and wrote no ERP`,
      existsSync(join(pluginsDir, "crm-pack")) && !existsSync(join(pluginsDir, "erp-pack")),
      "crm-pack present, erp-pack absent",
    )

    // 4. Restart. Now they mount — and they work, which is a different claim.
    await stopServer(server)
    ;({ server, api } = await boot(dataDir))
    if (!server.alive)
      return [...verdicts, { name: `pass ${pass}: restart`, ok: false, detail: server.output.slice(0, 200) }]
    session = await api.login()

    cubes = await api.call("/settings/cubes", { headers: session.headers })
    const namesAfter = (cubes.body ?? []).map((c) => c.name)
    say(
      `pass ${pass}: after restart — both cubes of the package are mounted`,
      cubesOf("crm-pack").every((c) => namesAfter.includes(c)),
      `looked for ${cubesOf("crm-pack").join(", ")}`,
    )

    const made = await api.call("/contacts", {
      method: "POST",
      headers: session.headers,
      body: JSON.stringify({ name: "Ion Probescu", email: "ion@example.org" }),
    })
    const readBack = made.body?.id
      ? await api.call(`/contacts/${made.body.id}`, { headers: session.headers })
      : { status: 0, body: null }
    say(
      `pass ${pass}: the installed cube actually works — a row written and read back`,
      made.status === 200 && readBack.status === 200 && readBack.body?.name === "Ion Probescu",
      `create http=${made.status}, read http=${readBack.status}`,
    )

    // 5. Uninstall while it is mounted. The running server must not be damaged by it.
    const removed = await api.call("/settings/packages/crm-pack", { method: "DELETE", headers: session.headers })
    say(
      `pass ${pass}: uninstall returns 200 and asks for a restart`,
      removed.status === 200 && removed.body?.requiresRestart === true,
      `http=${removed.status}`,
    )
    say(
      `pass ${pass}: uninstall took the directory off disk`,
      !existsSync(join(pluginsDir, "crm-pack")),
      "core/plugins/crm-pack gone",
    )

    const zombie = await api.call("/contacts", { headers: session.headers })
    say(
      `pass ${pass}: the already-mounted routes keep answering until the restart`,
      zombie.status === 200,
      `http=${zombie.status} — deleting files under a live server must not break it mid-request`,
    )

    // 6. Restart. Gone must mean "404", not "the application is down".
    await stopServer(server)
    ;({ server, api } = await boot(dataDir))
    say(
      `pass ${pass}: the application still starts after the package was removed`,
      server.alive,
      server.alive ? "" : server.output.slice(0, 200),
    )
    if (!server.alive) return verdicts

    session = await api.login()
    say(`pass ${pass}: login still works with the package gone`, session.status === 200, `http=${session.status}`)

    const after = await api.call("/contacts", { headers: session.headers })
    say(`pass ${pass}: /contacts is a 404 again, not a crash`, after.status === 404, `http=${after.status}`)

    cubes = await api.call("/settings/cubes", { headers: session.headers })
    const namesEnd = (cubes.body ?? []).map((c) => c.name)
    say(
      `pass ${pass}: the catalogue answers and no longer lists the removed cubes`,
      cubes.status === 200 && !namesEnd.includes("contacts") && !namesEnd.includes("contracts"),
      `http=${cubes.status}, mounted: ${namesEnd.join(", ")}`,
    )

    await stopServer(server)
    return verdicts
  } finally {
    dropScratch(dataDir)
  }
}
