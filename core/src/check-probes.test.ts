// Unit tests for the generic probes (QWB-54, ticket 08). The probes run against a MOCK of the
// sandbox kernel: a plain node:http server speaking the handful of endpoints the probes call.
// What is under test is the probe's judgment -- which answer means a kept promise, which
// means a finding -- not the kernel, which the sandbox boot proves for real.

import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { FetchHttpClient } from "@effect/platform"
import { describe, it, layer } from "@effect/vitest"
import { Effect } from "effect"

import { createPayload, type DeclarationsDump, fillPath, runGenericProbes, valueFor } from "./check-probes.ts"

// --- the mock kernel ---------------------------------------------------------------------------

type Reply = { status: number; body?: unknown }
type Handler = (req: IncomingMessage, body: string) => Reply | Promise<Reply>

const startMock = (handler: Handler): Promise<{ url: string; close: () => Promise<void> }> =>
  new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        const out = await handler(req, Buffer.concat(chunks).toString("utf8"))
        res.statusCode = out.status
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify(out.body ?? {}))
      })()
    })
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) })
    })
  })

const ROUTES = {
  list: { auth: true, permission: "gadgets:read", method: "GET", path: "/gadgets" },
  create: { auth: true, permission: "gadgets:write", method: "POST", path: "/gadgets" },
} as const

const FIELDS = [
  { name: "id", type: "string", required: false, editable: false, nullable: false, enum: null, custom: false },
  { name: "name", type: "string", required: true, editable: true, nullable: false, enum: null, custom: false },
]

const METADATA = { cube: "gadgets", fields: FIELDS, routes: ROUTES }

/**
 * A mock that behaves like a well-built kernel: login works, the probe user is created with
 * no permissions, every route demands its token and its permission, and the list filter
 * really narrows. Each test breaks ONE behaviour and expects exactly one finding.
 */
const mockKernel = (
  breaks: {
    openRoute?: boolean
    unenforcedPermission?: boolean
    ignoreFilter?: boolean
    noRequiredValidation?: boolean
    brokenBaseline?: boolean
    refuseAccount?: boolean
    refuseLogin?: boolean
    catalog?: readonly string[]
    metadata?: unknown
  } = {},
): Promise<{ url: string; close: () => Promise<void> }> =>
  startMock((req, body) => {
    // Route matching on the path alone; handlers read the query off req.url when they care.
    const path = (req.url ?? "/").split("?")[0] ?? "/"
    if (req.method === "POST" && path === "/auth/login") {
      if (breaks.refuseLogin) return { status: 500, body: { error: "down" } }
      const { username } = JSON.parse(body || "{}") as { username?: string }
      // The token names its identity: admin carries the permissions, the probe user none.
      return { status: 200, body: { token: username === "admin" ? "tok-admin" : "tok-noperms" } }
    }
    const who =
      req.headers.authorization === "Bearer tok-admin"
        ? "admin"
        : req.headers.authorization === "Bearer tok-noperms"
          ? "noperms"
          : null
    if (req.method === "POST" && path === "/account") {
      if (breaks.refuseAccount) return { status: 403, body: { error: "no" } }
      return { status: 201, body: { id: "u1" } }
    }
    if (req.method === "GET" && path === "/settings/cubes") {
      return { status: 200, body: (breaks.catalog ?? ["gadgets"]).map((name) => ({ name, enabled: true })) }
    }
    if (req.method === "GET" && path.startsWith("/catalog/gadgets/")) {
      return { status: breaks.metadata === null ? 404 : 200, body: breaks.metadata ?? METADATA }
    }
    if (path === "/gadgets" && req.method === "POST") {
      if (who === null) return { status: 401 }
      if (who === "noperms")
        return breaks.unenforcedPermission ? { status: 201, body: JSON.parse(body || "{}") } : { status: 403 }
      const parsed = JSON.parse(body || "{}") as Record<string, unknown>
      if (breaks.brokenBaseline) return { status: 500, body: { error: "boom" } }
      if (!breaks.noRequiredValidation && !("name" in parsed)) return { status: 400 }
      return { status: 201, body: parsed }
    }
    if (path === "/gadgets" && req.method === "GET") {
      const query = new URL(`http://x${req.url ?? ""}`).searchParams
      if (who === null) return breaks.openRoute ? { status: 200, body: { rows: [], total: 0 } } : { status: 401 }
      if (who === "noperms")
        return breaks.unenforcedPermission ? { status: 200, body: { rows: [], total: 0 } } : { status: 403 }
      const field = [...query.keys()].find((k) => k !== "page" && k !== "pageSize")
      const total = field && !breaks.ignoreFilter ? (query.get(field) ? 1 : 0) : 2
      return { status: 200, body: { rows: [], total } }
    }
    return { status: 404 }
  })

const dump = (over: Partial<DeclarationsDump> = {}): DeclarationsDump => ({
  cubes: {
    gadgets: {
      searchable: ["name"],
      relations: { orgId: { target: "gadgets" } },
    },
  },
  errors: {},
  ...over,
})

/** The probes against a mock that breaks `breaks`; the mock closes with the test's scope. */
const clean = (breaks?: Parameters<typeof mockKernel>[0], over?: Partial<DeclarationsDump>) =>
  Effect.gen(function* () {
    const kernel = yield* Effect.acquireRelease(
      Effect.promise(() => mockKernel(breaks)),
      (mock) => Effect.promise(mock.close),
    )
    const report = yield* runGenericProbes({
      url: kernel.url,
      adminPassword: "admin",
      cubes: ["gadgets"],
      declarations: dump(over),
    })
    return { report }
  })

// Real clock: the probes talk HTTP to a real (mock) server.
layer(FetchHttpClient.layer, { excludeTestServices: true })(
  "generic probes -- routing the five families against the metadata",
  (it) => {
    it.scoped("a well-built package raises no finding and runs every family", () =>
      Effect.gen(function* () {
        const { report } = yield* clean()
        assert.deepEqual(report.findings, [])
        // 401 list, 403 list, 401 create, 403 create, the required-missing check, the searchable
        // filter, the relation target -- every family visibly ran.
        assert.equal(report.checks, 7)
      }),
    )

    it.scoped("a route that answers without a token is caught by the 401 probe", () =>
      Effect.gen(function* () {
        const { report } = yield* clean({ openRoute: true })
        assert.equal(report.findings.length, 1)
        assert.equal(report.findings[0]?.rule, "route-auth")
        assert.match(report.findings[0]?.message ?? "", /list \(GET \/gadgets\) declares auth but answered 200/)
      }),
    )

    it.scoped("a permission declared but never enforced in the handler is caught by the 403 probe", () =>
      Effect.gen(function* () {
        const { report } = yield* clean({ unenforcedPermission: true })
        // Both published routes declare a permission in this mock, so both go unenforced -- the
        // probe reports each, naming route and permission.
        assert.equal(report.findings.length, 2)
        assert.ok(report.findings.every((f) => f.rule === "route-permission"))
        assert.match(
          report.findings[0]?.message ?? "",
          /declares permission gadgets:read but answered 200 for a token without it/,
        )
      }),
    )

    it.scoped("a relation to a cube outside the catalog fails, with the target named", () =>
      Effect.gen(function* () {
        const { report } = yield* clean(undefined, {
          cubes: { gadgets: { relations: { orgId: { target: "ghost-cube" } } } },
        })
        assert.equal(report.findings.length, 1)
        assert.equal(report.findings[0]?.rule, "relation-target")
        assert.match(
          report.findings[0]?.message ?? "",
          /points at cube "ghost-cube", which does not exist in the catalog/,
        )
      }),
    )

    it.scoped("a declared searchable field that is not a field of the cube fails", () =>
      Effect.gen(function* () {
        const { report } = yield* clean(undefined, {
          cubes: { gadgets: { searchable: ["nothere"], relations: {} } },
        })
        assert.equal(report.findings.length, 1)
        assert.equal(report.findings[0]?.rule, "searchable")
        assert.match(
          report.findings[0]?.message ?? "",
          /declares searchable field "nothere" but the cube publishes no such field/,
        )
      }),
    )

    it.scoped("a filter that does not narrow two rows to one fails", () =>
      Effect.gen(function* () {
        const { report } = yield* clean({ ignoreFilter: true })
        assert.equal(report.findings.length, 1)
        assert.equal(report.findings[0]?.rule, "searchable")
        assert.match(
          report.findings[0]?.message ?? "",
          /two rows plus the filter name=.* must answer exactly one row, got status 200 total 2/,
        )
      }),
    )

    it.scoped("a required field accepted while missing at create fails", () =>
      Effect.gen(function* () {
        const { report } = yield* clean({ noRequiredValidation: true })
        assert.equal(report.findings.length, 1)
        assert.equal(report.findings[0]?.rule, "required-field")
        assert.match(
          report.findings[0]?.message ?? "",
          /field name is required by the create contract but missing at create answered 20\d/,
        )
      }),
    )

    it.scoped("a create route the metadata cannot satisfy is reported, and the per-field checks wait", () =>
      Effect.gen(function* () {
        const { report } = yield* clean({ brokenBaseline: true })
        // The baseline create fails, so the required family reports it instead of trusting a 400;
        // the searchable family's row creation fails through the same broken route and says so.
        assert.equal(report.findings.length, 2)
        assert.equal(report.findings[0]?.rule, "required-field")
        assert.match(report.findings[0]?.message ?? "", /answered 500 -- the metadata cannot be turned into a row/)
        assert.equal(report.findings[1]?.rule, "searchable")
        assert.match(report.findings[1]?.message ?? "", /could not create the two rows the searchable probe needs/)
      }),
    )

    it.scoped("a kernel the probes cannot log into yields one finding, not a crash", () =>
      Effect.gen(function* () {
        const { report } = yield* clean({ refuseLogin: true })
        assert.equal(report.checks, 0)
        assert.equal(report.findings.length, 1)
        assert.equal(report.findings[0]?.rule, "generic-probes")
      }),
    )

    it.scoped("without a permissionless token the 403 probe says so instead of passing silently", () =>
      Effect.gen(function* () {
        const { report } = yield* clean({ refuseAccount: true })
        // One finding for the missing instrument, one per route whose permission went unprobed.
        assert.ok(report.findings.length >= 2)
        assert.equal(report.findings[0]?.rule, "generic-probes")
        assert.ok(report.findings.slice(1).every((f) => f.rule === "route-permission"))
      }),
    )
  },
)

describe("generic probes -- values built from published metadata", () => {
  it("fills every :param of a route template", () => {
    assert.equal(fillPath("/things/:id"), "/things/0")
    assert.equal(fillPath("/a/:one/b/:two"), "/a/0/b/0")
    assert.equal(fillPath("/plain"), "/plain")
  })

  it("builds payload values by published type, enums first", () => {
    assert.equal(valueFor({ type: "string", enum: null }, "s1"), "qwbe-probe-s1")
    assert.equal(valueFor({ type: "integer", enum: null }, "s2"), 1)
    assert.equal(valueFor({ type: "boolean", enum: null }, "s3"), true)
    assert.equal(valueFor({ type: "string", enum: ["a", "b"] }, "s4"), "a")
    assert.equal(valueFor({ type: "unknown", enum: null }, "s5"), undefined)
  })

  it("a create payload carries required, editable, non-custom fields only", () => {
    const payload = createPayload(
      [
        { name: "id", type: "string", required: false, editable: false, nullable: false, enum: null, custom: false },
        { name: "name", type: "string", required: true, editable: true, nullable: false, enum: null, custom: false },
        { name: "opt", type: "string", required: false, editable: true, nullable: false, enum: null, custom: false },
        { name: "runtime", type: "string", required: true, editable: true, nullable: false, enum: null, custom: true },
        { name: "odd", type: "unknown", required: true, editable: true, nullable: false, enum: null, custom: false },
      ],
      "s",
    )
    assert.deepEqual(Object.keys(payload), ["name"])
  })
})
