import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { Effect, Schema } from "effect"
import type { CubeTools } from "qwbe-core/cube"
import { defineCube, InvalidCubeContractError, validateCubeParts } from "./cube-contract.ts"
import { InvalidManifestError, validateAgentSurface } from "./kernel/manifest-validation.ts"

const group = HttpApiGroup.make("reference").add(HttpApiEndpoint.get("read")`/reference`.addSuccess(Schema.String))

const manifest = { name: "reference", tables: [], requiresAuth: false } as const
const tools = {} as CubeTools

describe("cube contract", () => {
  it("accepts matching endpoint handlers", () => {
    const cube = defineCube(group, {
      manifest,
      create: () => ({ handlers: { read: () => Effect.succeed("ok") } }),
    })
    assert.doesNotThrow(() => validateCubeParts("reference", cube.create(tools)))
  })

  it("refuses missing handlers after runtime discovery erases concrete types", () => {
    assert.throws(
      () => validateCubeParts("reference", { group, handlers: {} }),
      (error: Error) => error instanceof InvalidCubeContractError && error.message.includes("missing handlers: read"),
    )
  })

  it("refuses extra handlers after runtime discovery erases concrete types", () => {
    assert.throws(
      () =>
        validateCubeParts("reference", {
          group,
          handlers: { read: () => Effect.succeed("ok"), drift: () => Effect.void },
        }),
      /extra handlers: drift/,
    )
  })
})

defineCube(group, {
  manifest,
  create: () => ({
    handlers: {
      // @ts-expect-error Success must satisfy the endpoint's Effect Schema type.
      read: () => Effect.succeed(42),
    },
  }),
})

describe("agent surface gate", () => {
  const surfaceGroup = HttpApiGroup.make("fakeagent")
    .add(HttpApiEndpoint.get("health")`/fakeagent/health`)
    .add(HttpApiEndpoint.get("context")`/fakeagent/context`)
    .add(HttpApiEndpoint.post("goal")`/fakeagent/goals`)
    .add(HttpApiEndpoint.get("trace")`/fakeagent/trace`)

  it("accepts a cube declaring agent: true with the four contract routes", () => {
    assert.doesNotThrow(() =>
      validateAgentSurface("fakeagent", { ...manifest, name: "fakeagent", agent: true }, surfaceGroup),
    )
  })

  it("refuses agent: true when any contract route is missing", () => {
    assert.throws(
      () => validateAgentSurface("fakeagent", { ...manifest, name: "fakeagent", agent: true }, group),
      (error: Error) =>
        error instanceof InvalidManifestError && error.message.includes("does not serve the generic agent surface"),
    )
  })

  it("refuses a route served under another cube's prefix", () => {
    const foreign = HttpApiGroup.make("fakeagent")
      .add(HttpApiEndpoint.get("health")`/fakeagent/health`)
      .add(HttpApiEndpoint.get("context")`/other/context`)
      .add(HttpApiEndpoint.post("goal")`/fakeagent/goals`)
      .add(HttpApiEndpoint.get("trace")`/fakeagent/trace`)
    assert.throws(
      () => validateAgentSurface("fakeagent", { ...manifest, name: "fakeagent", agent: true }, foreign),
      /GET \/fakeagent\/context/,
    )
  })

  it("ignores cubes without the declaration", () => {
    assert.doesNotThrow(() => validateAgentSurface("reference", manifest, group))
  })
})
