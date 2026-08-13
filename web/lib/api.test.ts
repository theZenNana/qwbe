import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import { Schema } from "effect"

import { ApiError, agentApiPrefix, agentScreenPath, catalogue, list, request } from "./api.ts"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("request response contract", () => {
  it("keeps a child cube identity in its agent screen and uses its mounted HTTP prefix", () => {
    const child = {
      name: "parent/child",
      parent: "parent",
      prefix: "parent-child",
    }

    assert.equal(agentScreenPath(child), "/agent/parent/child")
    assert.equal(agentApiPrefix(child), "parent-child")
  })
  it("publishes the optional agent capability without cube-specific UI knowledge", async () => {
    globalThis.fetch = async () =>
      Response.json([
        {
          name: "future-agent-cube",
          parent: null,
          prefix: "future-agent-cube",
          enabled: true,
          required: false,
          system: false,
          plugin: "some-plugin",
          onDisk: true,
          entity: null,
          screen: false,
          agent: true,
          publishes: [],
          links: [],
        },
      ])

    assert.equal((await catalogue())[0]?.agent, true)
  })

  it("refuses a successful response that does not satisfy its schema", async () => {
    globalThis.fetch = async () => Response.json({ token: 42, expiresAt: "2026-08-11T20:00:00Z" })
    const Session = Schema.Struct({ token: Schema.String, expiresAt: Schema.String })

    await assert.rejects(request("/auth/login", Session), /token/)
  })

  it("returns a successful response after decoding it", async () => {
    globalThis.fetch = async () =>
      Response.json(
        Object.fromEntries([
          ["token", "opaque"],
          ["expiresAt", "2026-08-11T20:00:00Z"],
        ]),
      )
    const Session = Schema.Struct({ token: Schema.String, expiresAt: Schema.String })

    const decoded = await request("/auth/login", Session)
    assert.equal(decoded.token, "opaque")
    assert.equal(decoded.expiresAt, "2026-08-11T20:00:00Z")
  })

  it("preserves an HTTP refusal instead of reporting it as a decode failure", async () => {
    globalThis.fetch = async () => Response.json({ message: "authentication required" }, { status: 401 })

    await assert.rejects(
      request("/notes", Schema.Array(Schema.String)),
      (error: unknown) =>
        error instanceof ApiError && error.status === 401 && error.message === "authentication required",
    )
  })

  it("validates paging metadata while leaving discovered row fields unknown", async () => {
    globalThis.fetch = async () =>
      Response.json({
        rows: [{ id: "future-1", fieldAddedByAnInstalledCube: { nested: true } }],
        total: 1,
        offset: 0,
        limit: 10,
        sortedBy: "createdAt",
      })

    const page = await list("future-cube")
    assert.deepEqual(page.rows[0]?.fieldAddedByAnInstalledCube, { nested: true })
  })

  it("refuses a page missing metadata required by the OpenAPI contract", async () => {
    globalThis.fetch = async () => Response.json({ rows: [], total: 0, offset: 0, limit: 10 })

    await assert.rejects(list("notes"), /sortedBy/)
  })
})
