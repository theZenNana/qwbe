// Probe: per-cube field metadata (QWB-41).
//
// Green: the endpoint answers per cube, the response matches the generated OpenAPI, the
// relation `partyId` on crm/contracts resolves to crm/contacts with its summary mechanism,
// and a caller without the cube's read permission learns no shape.
// Red: a fixture cube whose schema changes WITHOUT bumping its declared `version` must keep
// the server from starting -- and pass once the version is bumped. That is the drift gate,
// proven against a real mounted cube, not by hand.

import { existsSync } from "node:fs"
import { responseConforms } from "./contract-validator.mjs"
import { dropFixture, fixtureRoot, writeFixture } from "./cube-metadata-fixture.mjs"
import { client, dropScratch, freePort, makeScore, scratchDataDir, startServer, stopServer } from "./lib.mjs"

const port = await freePort()
const data = scratchDataDir("cube-metadata")
const score = makeScore()
const api = client(port)

if (existsSync(fixtureRoot)) {
  console.error(`refused: ${fixtureRoot} already exists and was not planted by this probe`)
  process.exit(1)
}

const start = async (env = {}) => {
  const s = await startServer(port, { QWBE_DATA_DIR: data, ...env })
  if (!s.alive) throw new Error(`server did not start:\n${s.output}`)
  return s
}

let server
try {
  writeFixture("", "1.0.0")
  server = await start()

  // The spec carries every cube's schema, so it sits behind authentication like the metadata.
  const adminForSpec = await api.login()
  const spec = (await api.call("/openapi.json", { headers: adminForSpec.headers })).body
  score.check("the spec is not readable without a session", (await api.call("/openapi.json")).status === 401)

  // --- authentication: the shape is not public ---
  const anonymous = await api.call("/catalog/notes/metadata")
  score.check(
    "anonymous metadata request is 401 and matches the declared error",
    anonymous.status === 401 && responseConforms(spec, "/catalog/{cube}/metadata", "get", 401, anonymous.body),
  )

  const admin = await api.login()
  const metadataOf = (cube) => api.call(`/catalog/${encodeURIComponent(cube)}/metadata`, { headers: admin.headers })

  // --- the derived metadata of a real plugin cube ---
  const contracts = await metadataOf("crm/contracts")
  score.check(
    "GET /catalog/crm/contracts/metadata matches the OpenAPI schema",
    contracts.status === 200 && responseConforms(spec, "/catalog/{cube}/metadata", "get", 200, contracts.body),
  )
  const byName = new Map((contracts.body?.fields ?? []).map((f) => [f.name, f]))
  score.check(
    "partyId resolves to crm/contacts with summaryById",
    byName.get("partyId")?.relation?.target === "crm/contacts" &&
      byName.get("partyId")?.relation?.entity === "Contact" &&
      byName.get("partyId")?.relation?.summary === "summaryById",
  )
  score.check(
    "partyId is nullable and not sortable, title is sortable, amount is an integer",
    byName.get("partyId")?.nullable === true &&
      byName.get("partyId")?.sortable === false &&
      byName.get("title")?.sortable === true &&
      byName.get("amount")?.type === "integer",
  )
  score.check(
    "editable and required come from the create payload, meta columns are never editable",
    byName.get("title")?.required === true &&
      byName.get("amount")?.editable === true &&
      byName.get("amount")?.required === false &&
      byName.get("id")?.editable === false &&
      byName.get("createdAt")?.editable === false,
  )
  score.check(
    "a schema fingerprint is published for every cube; an undeclared version is null",
    /^[0-9a-f]{64}$/.test(contracts.body?.schemaHash ?? "") && contracts.body?.version === null,
  )
  const driftMeta = await metadataOf("metadrift")
  score.check(
    "the fixture's declared version and fingerprint are published",
    driftMeta.status === 200 &&
      driftMeta.body?.version === "1.0.0" &&
      /^[0-9a-f]{64}$/.test(driftMeta.body?.schemaHash ?? ""),
  )

  // --- permission: the shape is readable exactly as far as the cube is ---
  const post = (path, headers, body) => api.call(path, { method: "POST", headers, body: JSON.stringify(body) })
  const [readerName, readerPass] = ["metareader", "reader-pass"]
  await post("/account", admin.headers, { username: readerName, password: readerPass, roles: ["reader"] })
  const reader = await api.login(readerName, readerPass)
  const readerMetadata = (cube) =>
    api.call(`/catalog/${encodeURIComponent(cube)}/metadata`, { headers: reader.headers })
  score.check(
    "a reader reads the metadata of a cube it can read",
    readerMetadata && (await readerMetadata("crm/contacts")).status === 200,
  )
  const denied = await readerMetadata("permissions")
  score.check(
    "a caller without the cube's read permission gets 403, not the shape",
    denied.status === 403 && responseConforms(spec, "/catalog/{cube}/metadata", "get", 403, denied.body),
  )
  score.check("an unknown cube is 404, never an empty shape", (await metadataOf("no-such-cube")).status === 404)

  // --- the drift gate: same version, changed schema -> the server refuses to start ---
  await stopServer(server)
  writeFixture(", flag: Schema.Boolean", "1.0.0")
  const drifted = await startServer(port, { QWBE_DATA_DIR: data })
  score.check(
    "RED: a field added without bumping the version keeps the server from starting",
    !drifted.alive && drifted.output.includes("but its schema changed"),
    drifted.alive ? "server started anyway" : drifted.output.slice(-400),
  )
  if (drifted.alive) await stopServer(drifted)

  writeFixture(", flag: Schema.Boolean", "1.1.0")
  server = await start()
  const bumped = await api.call("/catalog/metadrift/metadata", { headers: admin.headers })
  score.check(
    "after the version bump the fixture mounts and publishes version 1.1.0",
    bumped.status === 200 && bumped.body?.version === "1.1.0" && bumped.body?.fields?.some((f) => f.name === "flag"),
  )
} catch (e) {
  console.error(e.message)
  score.check("probe ran to completion", false, e.message)
} finally {
  if (server) await stopServer(server).catch(() => {})
  dropFixture()
  dropScratch(data)
}

process.exit(score.report("cube metadata probe"))
