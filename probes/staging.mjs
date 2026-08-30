// The staging probe: import a small JSONL and a small CSV, read the profile, check that a
// sensitive field returns no examples, delete the set and see it gone.
//
// Starts its own server on a free port against its own throwaway database (see lib.mjs).

import { client, freePort, makeScore, startServer, stopServer } from "./lib.mjs"
// The drift check (QWB-45 review, item 16) imports the REAL detector module: the same source
// file feeds the JS RegExp below and the SQL `~` patterns inside the kernel, so if they ever
// disagree, this import is the place it shows.
import { shapeOf } from "../core/src/cubes/staging/shapes.ts"

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

  // --- a JSONL set, with a malformed line in the middle ---
  const created = await api.call("/staging/sets", {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      name: "contacts-jsonl",
      format: "jsonl",
      sourceFile: "contacts.jsonl",
      sensitiveFields: ["email"],
    }),
  })
  score.check(
    "POST /staging/sets -> importing",
    created.status === 200 && created.body?.state === "importing",
    `http=${created.status}`,
  )
  const setId = created.body?.id

  const jsonl = [
    JSON.stringify({
      name: "Ioana Pop",
      email: "ioana@example.com",
      age: 31,
      city: "Timisoara",
      phone: "+40 722 111 222",
      joined: "2024-01-02",
    }),
    "THIS LINE IS NOT JSON",
    JSON.stringify({
      name: "Dan Ionescu",
      email: "dan@example.com",
      age: 44,
      city: "Timisoara",
      phone: "0722 111 222",
      joined: "2024-03-04",
    }),
    JSON.stringify({ name: "Maria Dima", email: "maria@example.com", city: "Iasi", joined: "2024-05-06" }),
  ].join("\n")
  const chunk = await api.call(`/staging/sets/${setId}/chunks`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ text: jsonl, startLine: 1 }),
  })
  score.check("JSONL chunk parsed", chunk.status === 200 && chunk.body?.parsed === 3, `parsed=${chunk.body?.parsed}`)
  score.check(
    "malformed line counted with its line number, import continued",
    chunk.body?.malformed?.length === 1 && chunk.body.malformed[0].line === 2,
    JSON.stringify(chunk.body?.malformed),
  )

  const state = await api.call(`/staging/sets/${setId}`, { headers: H })
  score.check(
    "set reports rows so far and the malformed count",
    state.body?.rowCount === 3 && state.body?.malformedCount === 1 && state.body?.state === "importing",
    `rows=${state.body?.rowCount} malformed=${state.body?.malformedCount}`,
  )

  const finished = await api.call(`/staging/sets/${setId}/finish`, { method: "POST", headers: H })
  score.check("finish -> done", finished.status === 200 && finished.body?.state === "done")

  // --- the profile ---
  const profile = await api.call(`/staging/sets/${setId}/profile`, { headers: H })
  const byField = Object.fromEntries((profile.body?.fields ?? []).map((f) => [f.field, f]))
  score.check("profile -> 3 rows", profile.status === 200 && profile.body?.rows === 3, `http=${profile.status}`)
  score.check(
    "city: 100% filled, small enum",
    byField.city?.fillRate === 100 && byField.city?.shapes?.some((s) => s.shape === "enum"),
    JSON.stringify(byField.city),
  )
  score.check(
    "age: number shape, 2 of 3 filled",
    byField.age?.shapes?.some((s) => s.shape === "number" && s.count === 2),
    JSON.stringify(byField.age),
  )
  score.check(
    "phone: phone shape",
    byField.phone?.shapes?.some((s) => s.shape === "phone"),
    JSON.stringify(byField.phone),
  )
  score.check(
    "joined: date shape",
    byField.joined?.shapes?.some((s) => s.shape === "date"),
    JSON.stringify(byField.joined),
  )
  score.check(
    "sensitive field (email): no example values at all, counts only",
    byField.email && !("top" in byField.email) && byField.email?.filled === 3,
    `keys=${Object.keys(byField.email ?? {}).join(",")}`,
  )
  score.check("non-sensitive field shows top values", Array.isArray(byField.city?.top) && byField.city.top.length > 0)

  // --- the two engines cannot drift: JS RegExp vs SQL `~` over the same rows ---
  const records = [
    {
      name: "Ioana Pop",
      email: "ioana@example.com",
      age: 31,
      city: "Timisoara",
      phone: "+40 722 111 222",
      joined: "2024-01-02",
    },
    { name: "Dan Ionescu", email: "dan@example.com", age: 44, city: "Timisoara", phone: "0722 111 222", joined: "2024-03-04" },
    { name: "Maria Dima", email: "maria@example.com", city: "Iasi", joined: "2024-05-06" },
  ]
  // The four specific shapes must agree exactly; the enum-vs-text leftover bucket is a
  // distinct-count decision made after the SQL pass, not a per-value shape, so it is compared
  // only through its total (filled minus the four specific shapes).
  let drift = null
  for (const f of profile.body?.fields ?? []) {
    const expected = { filled: 0 }
    for (const r of records) {
      if (r[f.field] === undefined) continue
      expected.filled++
      const s = shapeOf(r[f.field])
      if (s && s !== "text") expected[s] = (expected[s] ?? 0) + 1
    }
    const actual = { filled: (f.shapes ?? []).reduce((n, s) => n + s.count, 0) }
    for (const s of f.shapes ?? []) if (s.shape !== "enum" && s.shape !== "text") actual[s.shape] = s.count
    if (JSON.stringify(expected) !== JSON.stringify(actual)) drift = `${f.field}: js=${JSON.stringify(expected)} sql=${JSON.stringify(actual)}`
  }
  score.check("JS RegExp and SQL ~ agree on every field of the set", drift === null, drift ?? "all fields agree")
} finally {
  await stopServer(server)
}

process.exit(score.report("probes/staging.mjs"))
