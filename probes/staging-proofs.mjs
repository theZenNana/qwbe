// The two proofs the QWB-45 review required, as their own probe (split from staging-life.mjs
// for the size cap):
//
//   1. a multi-chunk CSV import whose rows come back intact -- split a file mid-way, import it
//      in two chunks, and assert every row, every field name and a matching parsed counter;
//   2. a profile over a set with obviously sensitive-looking values, asserting that no whole
//      value is returned: nothing longer than the truncation limit, and nothing at all for a
//      field marked sensitive.

import { client, freePort, makeScore, startServer, stopServer } from "./lib.mjs"

const PORT = await freePort()
const score = makeScore()
const api = client(PORT)

const server = await startServer(PORT)
if (!server.alive) {
  console.error(`server did not start:\n${server.output}`)
  process.exit(1)
}

try {
  const session = await api.login()
  const H = session.headers
  score.check("login -> token", session.status === 200 && !!session.token)

  // --- PROOF 1: a multi-chunk CSV import whose rows come back intact ---
  // Split mid-file (on the line boundary -- the chunk contract), import in two chunks: the
  // second chunk holds DATA rows only, parsed against the header stored at the first chunk.
  const mcSet = await api.call("/staging/sets", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ name: "multi-chunk", format: "csv", sourceFile: "split.csv" }),
  })
  const mcChunk1 = "name,city,phone\nDan,Iasi,0722111222\n"
  const mcChunk2 = "Maria,Cluj,0722111333\nIoana,Timisoara,0722111444"
  const mc1 = await api.call(`/staging/sets/${mcSet.body?.id}/chunks`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ text: mcChunk1, startLine: 1 }),
  })
  const mc2 = await api.call(`/staging/sets/${mcSet.body?.id}/chunks`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ text: mcChunk2, startLine: 2 }),
  })
  score.check(
    "multi-chunk CSV: both chunks parse with no malformed lines",
    mc1.status === 200 && mc1.body?.parsed === 1 && mc1.body?.malformed?.length === 0 &&
      mc2.status === 200 && mc2.body?.parsed === 2 && mc2.body?.malformed?.length === 0,
    `c1=${JSON.stringify(mc1.body)} c2=${JSON.stringify(mc2.body)}`,
  )
  const mcProfile = await api.call(`/staging/sets/${mcSet.body?.id}/profile`, { headers: H })
  const mcFields = (mcProfile.body?.fields ?? []).map((f) => f.field).sort()
  const mcTop = (mcProfile.body?.fields ?? []).find((f) => f.field === "city")?.top ?? []
  const mcValues = (mcProfile.body?.fields ?? []).find((f) => f.field === "name")?.top ?? []
  score.check(
    "multi-chunk CSV: field names are the header, not customer data",
    JSON.stringify(mcFields) === JSON.stringify(["city", "name", "phone"]),
    JSON.stringify(mcFields),
  )
  score.check(
    "multi-chunk CSV: every row and value survived the split",
    mcProfile.body?.rows === 3 &&
      ["Dan", "Maria", "Ioana"].every((n) => mcValues.some((t) => t.value === n)) &&
      ["Iasi", "Cluj", "Timisoara"].every((c) => mcTop.some((t) => t.value === c)),
    `rows=${mcProfile.body?.rows} names=${JSON.stringify(mcValues)} cities=${JSON.stringify(mcTop)}`,
  )

  // --- PROOF 2: the profile never returns a whole raw value ---
  const secretSet = await api.call("/staging/sets", {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      name: "sensitive-values",
      format: "jsonl",
      sourceFile: "dump.jsonl",
      sensitiveFields: ["note"],
    }),
  })
  const longNote = "customer asked for a callback about the open invoice and left a long address"
  const secretRows = [
    { name: "Ana", note: longNote },
    { name: "Bogdan", note: longNote },
  ]
  const secretChunk = await api.call(`/staging/sets/${secretSet.body?.id}/chunks`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ text: secretRows.map((r) => JSON.stringify(r)).join("\n") }),
  })
  const secretProfile = await api.call(`/staging/sets/${secretSet.body?.id}/profile`, { headers: H })
  const secretFields = Object.fromEntries((secretProfile.body?.fields ?? []).map((f) => [f.field, f]))
  const topValues = (secretProfile.body?.fields ?? []).flatMap((f) => (f.top ?? []).map((t) => t.value))
  score.check(
    "sensitive-looking set imported",
    secretChunk.status === 200 && secretChunk.body?.parsed === 2,
    `http=${secretChunk.status}`,
  )
  score.check(
    "PROOF profile: a sensitive field returns NO example values at all",
    secretFields.note && !("top" in secretFields.note),
    JSON.stringify(secretFields.note),
  )
  score.check(
    "PROOF profile: no value longer than the truncation limit leaves the profile",
    topValues.length > 0 && topValues.every((v) => v.length <= 40) && !topValues.some((v) => v.includes(longNote)),
    `max=${Math.max(...topValues.map((v) => v.length))}`,
  )
} finally {
  await stopServer(server)
}

process.exit(score.report("probes/staging-proofs.mjs"))
