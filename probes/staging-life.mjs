// The staging lifecycle probe, split from staging.mjs for the size cap: the CSV format, a
// sensitive field marked AFTER creation (the profile must then return counts only), deletion
// of a set, and who may read or write.

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

  // --- sensitive marking can also come later ---
  const csvSet = await api.call("/staging/sets", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ name: "contacts-csv", format: "csv", sourceFile: "contacts.csv" }),
  })
  const csv = 'name,city,phone\n"Io, ana",Timisoara,+40 722 111 222\nDan,Iasi,0722 111 222\nMaria,"Ia\nsi",0230 111 222'
  const csvChunk = await api.call(`/staging/sets/${csvSet.body?.id}/chunks`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ text: csv }),
  })
  score.check(
    "CSV chunk parsed with quoted commas and newlines",
    csvChunk.status === 200 && csvChunk.body?.parsed === 3,
    `parsed=${csvChunk.body?.parsed}`,
  )

  const marked = await api.call(`/staging/sets/${csvSet.body?.id}/sensitive`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ fields: ["phone"] }),
  })
  score.check(
    "sensitive marking after creation",
    marked.status === 200 && marked.body?.sensitiveFields?.[0] === "phone",
  )

  const csvProfile = await api.call(`/staging/sets/${csvSet.body?.id}/profile`, { headers: H })
  const csvFields = Object.fromEntries((csvProfile.body?.fields ?? []).map((f) => [f.field, f]))
  score.check(
    "CSV profile: name field with comma value, phone suppressed",
    !("top" in (csvFields.phone ?? {})) && csvFields.name?.distinct === 3,
    JSON.stringify(csvFields.name),
  )

  // --- PROOF (QWB-45 review): a multi-chunk CSV import whose rows come back intact ---
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

  // --- PROOF (QWB-45 review): the profile never returns a whole raw value ---
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
  score.check(
    "CSV values are strings, so a numeric-looking phone is still text or phone shape",
    (csvFields.phone?.shapes ?? []).length > 0,
  )

  // a reader may read but not write
  const reader = await client(PORT).login("reader", "reader")
  const readerWrite = await api.call("/staging/sets", {
    method: "POST",
    headers: reader.headers,
    body: JSON.stringify({ name: "no", format: "jsonl" }),
  })
  score.check("reader cannot import (staging:write is admin)", readerWrite.status === 403, `http=${readerWrite.status}`)
  const readerRead = await api.call("/staging/sets", { headers: reader.headers })
  score.check("reader can list sets", readerRead.status === 200, `http=${readerRead.status}`)

  // --- delete: one transaction, gone, and a 404 afterwards ---
  const deleted = await api.call(`/staging/sets/${csvSet.body?.id}`, { method: "DELETE", headers: H })
  score.check("DELETE /staging/sets/{id} -> removed", deleted.status === 200 && deleted.body?.removed === csvSet.body?.id, `http=${deleted.status}`)
  const afterDelete = await api.call(`/staging/sets/${csvSet.body?.id}`, { headers: H })
  score.check("deleted set -> 404", afterDelete.status === 404, `http=${afterDelete.status}`)
  const listAfter = await api.call("/staging/sets", { headers: H })
  score.check(
    "deleted set is out of the list (its rows went with it, in the same transaction)",
    listAfter.status === 200 && !(listAfter.body ?? []).some((s) => s.id === csvSet.body?.id),
    `sets=${(listAfter.body ?? []).length}`,
  )
} finally {
  await stopServer(server)
}

process.exit(score.report("probes/staging-life.mjs"))
