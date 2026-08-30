// Performance evidence for QWB-45: import a generated 100-thousand-row JSONL file in chunks
// and profile it. The numbers are printed; nothing is hidden.
//
//   node probes/staging-perf.mjs

import { performance } from "node:perf_hooks"
import { client, freePort, startServer, stopServer, wait } from "./lib.mjs"

const TOTAL = 100_000
const CHUNK_LINES = 1_000
const PORT = await freePort()
const api = client(PORT)

const server = await startServer(PORT)
if (!server.alive) {
  console.error(`server did not start:\n${server.output}`)
  process.exit(1)
}

const cities = ["Timisoara", "Iasi", "Cluj", "Brasov", "Bucuresti"]
let seed = 42
// deterministic LCG, written without an assignment-in-expression (biome refuses those)
const next = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}
const rand = next

const row = (i) =>
  JSON.stringify({
    name: `Person ${i}`,
    email: `person${i}@example.com`,
    age: 20 + Math.floor(rand() * 50),
    city: cities[Math.floor(rand() * cities.length)],
    phone: `+40 7${Math.floor(rand() * 10)}${Math.floor(rand() * 10000000)}`.slice(0, 13),
    joined: `202${Math.floor(rand() * 5)}-0${1 + Math.floor(rand() * 9)}-1${Math.floor(rand() * 9)}`,
    note: i % 3 === 0 ? "customer asked for a callback about the open invoice" : "",
  })

try {
  const session = await api.login()
  const H = session.headers
  const t0 = performance.now()
  const created = await api.call("/staging/sets", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ name: "perf", format: "jsonl", sourceFile: "perf.jsonl" }),
  })
  const setId = created.body.id

  let sent = 0
  while (sent < TOTAL) {
    const lines = []
    for (let i = 0; i < CHUNK_LINES && sent + i < TOTAL; i++) lines.push(row(sent + i))
    const r = await api.call(`/staging/sets/${setId}/chunks`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ text: `${lines.join("\n")}\n`, startLine: sent + 1 }),
    })
    if (r.status !== 200 || r.body?.parsed !== lines.length) {
      console.error(`chunk failed at line ${sent}: http=${r.status}`, JSON.stringify(r.body).slice(0, 300))
      await wait(300)
      console.error(
        server.output
          .split("\n")
          .filter((l) => l.includes("error"))
          .slice(-3)
          .join("\n"),
      )
      process.exit(1)
    }
    sent += lines.length
  }
  await api.call(`/staging/sets/${setId}/finish`, { method: "POST", headers: H })
  const importMs = Math.round(performance.now() - t0)

  const state = await api.call(`/staging/sets/${setId}`, { headers: H })
  const t1 = performance.now()
  const profile = await api.call(`/staging/sets/${setId}/profile`, { headers: H })
  const profileMs = Math.round(performance.now() - t1)

  const rows = state.body?.rowCount ?? 0
  const fields = profile.body?.fields ?? []
  console.log(
    `\nstaging perf: ${rows} rows imported in ${importMs} ms (${(rows / (importMs / 1000) / 1000).toFixed(1)}k rows/s)`,
  )
  console.log(`staging perf: profile of ${fields.length} fields in ${profileMs} ms`)
  console.log(`staging perf: biggest field profile -- ${fields.map((f) => `${f.field}:${f.filled}`).join(", ")}`)
  if (rows !== TOTAL) {
    console.error(`FAIL: expected ${TOTAL} rows on the set, got ${rows}`)
    process.exitCode = 1
  }
} finally {
  await stopServer(server)
}
