// Restart durability. This probe exists because of a specific bug, and it stays so the bug
// cannot come back quietly.
//
//   node probes/restart.mjs
//
// The bug: ids came from a module-level counter that started at 0 on every boot and was SHARED
// across all cubes. Two restarts were survivable by luck; the third handed out an id that
// already existed and login died permanently:
//
//     restart 0  login 200
//     restart 1  login 200
//     restart 2  login 500   UNIQUE constraint failed: sessions.id
//
// Nothing self-healed — every subsequent start hit the same collision. Found by an adversarial
// review, reproduced here before the fix, and now guarded.

import { client, dropScratch, freePort, makeScore, scratchDataDir, startServer, stopServer, wait } from "./lib.mjs"

const RESTARTS = 5
const score = makeScore()

// The whole point is that all five boots share ONE database, so the directory is made once and
// every boot is pointed at it. It is a scratch directory rather than `<root>/data`: the bug this
// probe guards only shows up against a database that already has rows, and the owner's own
// database having rows in it is not the same experiment.
const dataDir = scratchDataDir("restart")

const codes = []
const ids = []

for (let i = 0; i < RESTARTS; i++) {
  const port = await freePort()
  const api = client(port)
  const server = await startServer(port, { QWBE_DATA_DIR: dataDir })
  if (!server.alive) {
    codes.push(`start-failed:${server.output.slice(0, 120)}`)
    break
  }
  const session = await api.login()
  codes.push(session.status)

  if (session.status === 200) {
    // Write a row on each boot too — the shared counter also collided on notes and accounts as
    // soon as the sequence passed an id already on disk.
    const note = await api.call("/notes", {
      method: "POST",
      headers: session.headers,
      body: JSON.stringify({ title: `boot ${i}`, body: "" }),
    })
    ids.push(note.body?.id ?? `err:${note.status}`)
  }

  await stopServer(server)
  await wait(300)
}

score.check(
  `login survives ${RESTARTS} restarts against the same database`,
  codes.every((c) => c === 200),
  `login status per restart: ${codes.join(", ")}`,
)

score.check(
  "every row written across restarts got a distinct id",
  new Set(ids).size === ids.length && ids.every((i) => !String(i).startsWith("err:")),
  `ids: ${ids.join(", ")}`,
)

score.check(
  "ids are not a shared sequence that restarts at zero",
  !ids.some((id) => String(id).endsWith("-0001")),
  "no id ends in -0001, which is what a fresh counter would produce every boot",
)

dropScratch(dataDir)

process.exit(score.report("Restart probe"))
