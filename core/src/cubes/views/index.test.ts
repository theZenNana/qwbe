// QWB-62 kernel stage: the trust boundary of the views cube and the contract it publishes.
//
// The two-user ownership/share walk (owner/other/shared-read/no-edit/no-reshare/transfer)
// is a LIVE probe -- probes/views.mjs -- because it is the kernel entity-enforcement
// wrapper plus the permissions cube that own those decisions. This file pins the parts
// that are the cube's own code: the config trust boundary and the published routes.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { deriveCubeMetadata } from "../../metadata/metadata.ts"
import { cube } from "./index.ts"
import { encodeTargetCube, encodeViewConfig, encodeViewName } from "./view-config.ts"

// Only the group is needed to read the contract; the handlers are never invoked here.
const tools = { store: {}, bus: { publish: () => undefined as never } } as never
const md = deriveCubeMetadata(
  { name: cube.manifest.name, manifest: cube.manifest, parts: { group: cube.create(tools).group } } as never,
  [],
  [],
)

const rejects = (fn: () => unknown, pattern: RegExp) => {
  assert.throws(fn, (e: unknown) => {
    const message = (e as { message?: string }).message ?? ""
    return String(e).includes("BadRequest") && pattern.test(message)
  })
}

describe("views metadata -- routes published from the one declaration", () => {
  it("publishes each route's permission from the manifest's routes map", () => {
    assert.ok(md)
    assert.deepEqual(md.routes, {
      list: { auth: true, permission: "views:read", method: "GET", path: "/views" },
      get: { auth: true, permission: "views:read", method: "GET", path: "/views/:id" },
      create: { auth: true, permission: "views:write", method: "POST", path: "/views" },
      update: { auth: true, permission: "views:write", method: "PATCH", path: "/views/:id" },
      remove: { auth: true, permission: "views:write", method: "DELETE", path: "/views/:id" },
    })
  })

  it("grants the feature to ordinary readers, per the owner's decision", () => {
    // The auth cube derives every user's permissions from exactly these role lists.
    assert.deepEqual(
      cube.manifest.permissions?.map((p) => [p.name, p.roles]),
      [
        ["views:read", ["admin", "reader"]],
        ["views:write", ["admin", "reader"]],
      ],
    )
  })
})

describe("view config -- the trust boundary", () => {
  it("decodes, bounds and re-encodes a valid config (raw JSON is never stored)", () => {
    const encoded = encodeViewConfig({ columns: ["name", "q"], filters: { status: "open" }, pageSize: 50 })
    assert.equal(encoded, '{"columns":["name","q"],"filters":{"status":"open"},"pageSize":50}')
  })

  it("a reserved query name is a legal COLUMN but an illegal FILTER KEY", () => {
    // The brief's correction: reserved names constrain filters, not valid visible columns.
    assert.doesNotThrow(() => encodeViewConfig({ columns: ["sort", "page"] }))
    rejects(() => encodeViewConfig({ filters: { page: "2" } }), /reserved/)
    rejects(() => encodeViewConfig({ filters: { sortBy: "x" } }), /reserved/)
  })

  it("rejects unknown top-level keys", () => {
    rejects(() => encodeViewConfig({ grouping: true }), /unexpected/)
  })

  it("rejects out-of-bounds values", () => {
    rejects(() => encodeViewConfig({ pageSize: 0 }), /pageSize/)
    rejects(() => encodeViewConfig({ pageSize: 999 }), /pageSize/)
    rejects(() => encodeViewConfig({ pageSize: 2.5 }), /pageSize/)
    rejects(() => encodeViewConfig({ filters: { a: "x".repeat(201) } }), /200 chars/)
    rejects(() => encodeViewConfig({ q: "x".repeat(201) }), /q over/)
    rejects(() => encodeViewConfig({ columns: Array.from({ length: 61 }, (_, i) => `f${i}`) }), /60 columns/)
    rejects(
      () => encodeViewConfig({ filters: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`f${i}`, "x"])) }),
      /30 filters/,
    )
    rejects(() => encodeViewConfig({ columns: ["a", "a"] }), /duplicate/)
    rejects(() => encodeViewConfig({ columns: ["has space"] }), /field name/)
    rejects(() => encodeViewConfig({ filters: { "a-b": "x" } }), /field name/)
  })

  it("rejects a config over 8 KB", () => {
    const bloated = {
      columns: Array.from({ length: 60 }, (_, i) => `f${i}`.padEnd(64, "x")),
      filters: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`.padEnd(64, "y"), "v".repeat(200)])),
    }
    rejects(() => encodeViewConfig(bloated), /8192 bytes/)
  })

  it("bounds name and targetCube; PATCH-style payloads cannot move targetCube", () => {
    rejects(() => encodeViewName("   "), /1\.\.80/)
    rejects(() => encodeViewName("x".repeat(81)), /1\.\.80/)
    assert.equal(encodeViewName("  Mine  "), "Mine")
    rejects(() => encodeTargetCube(""), /targetCube/)
    rejects(() => encodeTargetCube("crm/organizations extra"), /targetCube/)
    assert.equal(encodeTargetCube("crm/organizations"), "crm/organizations")
  })
})
