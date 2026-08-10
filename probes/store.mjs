#!/usr/bin/env node
// The shelf, whatever state it is in, answered honestly.
//
//   node probes/store.mjs
//
// Until 10 Aug 2026 this probe mounted every package on `core/store/` and refused an empty
// shelf, because the store was the source users installed from and an untested package there was
// a silent lie. QWB-13 moved every pack out of the repo; the shelf is empty on purpose now, and
// the earlier refusal - "a probe over nothing would pass forever" - became the lie it guarded
// against: the probe would have demanded fixtures the repo no longer ships.
//
// What remains true and worth measuring over HTTP, not the filesystem:
//
//   1. A MISSING shelf is a valid state. The catalogue answers 200 with an empty list, not a
//      500. (The installer already treats it so: `available()` returns [] when the directory is
//      absent. This probe keeps that promise honest.)
//   2. The mounted cube list still answers, and nothing on it claims to be waiting for disk.

import { client, dropScratch, freePort, makeScore, scratchDataDir, startServer, stopServer } from "./lib.mjs"

const port = await freePort()
const dataDir = scratchDataDir("store")
const api = client(port)
const score = makeScore()

const server = await startServer(port, { QWBE_DATA_DIR: dataDir })

try {
  if (!server.alive) throw new Error(`server did not start:\n${server.output}`)
  const session = await api.login()

  const packages = await api.call("/settings/packages", { headers: session.headers })
  score.check(
    "the empty shelf answers 200 with an empty list, not an error",
    packages.status === 200 && Array.isArray(packages.body) && packages.body.length === 0,
    `http=${packages.status} body=${JSON.stringify(packages.body).slice(0, 120)}`,
  )

  const cubes = await api.call("/settings/cubes", { headers: session.headers })
  score.check(
    "the cube catalogue still answers with the mounted cubes",
    cubes.status === 200 && Array.isArray(cubes.body) && cubes.body.length > 0,
    `http=${cubes.status} mounted=${(cubes.body ?? []).length}`,
  )
} finally {
  await stopServer(server)
  dropScratch(dataDir)
}

process.exit(score.report("Store probe - the empty shelf is a valid, answered state"))
