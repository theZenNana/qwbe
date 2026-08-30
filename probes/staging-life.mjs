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
  score.check(
    "DELETE /staging/sets/{id} -> removed",
    deleted.status === 200 && deleted.body?.removed === csvSet.body?.id,
    `http=${deleted.status}`,
  )
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
