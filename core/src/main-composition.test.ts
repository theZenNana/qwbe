// The anti-drift probe for the layer composition in main.ts (QWB-38).
//
// The composition that used to carry the kernel's only `as unknown as` cast is now cast-free:
// `parts.layers` (typed `Layer<Provided, unknown, Registry>`) is provided the `Registry`,
// closed with `Layer.orDie`, and merged. Two things can drift silently, and this probe drops
// on both:
//
//   1. TYPE: if `CubeParts.layers` ever stops being `Layer<never, unknown, Registry> |
//      undefined` as discovery erases it into `MountedCube`, the first check stops
//      compiling -- and `main.ts`'s filter and `mergeAll` stop meaning what they say.
//   2. RUNTIME: if the composition stops actually SERVING what a cube layer provides (the
//      way the auth cube's `AuthorizationLive` reaches every handler), the second check
//      fails at runtime -- the layer still builds, but the tag it promised is gone.
//
// The fixture cube is `defineCube`-built, exactly like a real cube; it contributes a layer
// over a `Registry` fixture, composed the way main.ts composes it.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { Context, Effect, Layer, Schema } from "effect"
import { defineCube } from "qwbe-core/cube"
import type { MountedCube } from "./kernel/discovery.ts"
import { Registry } from "./kernel/registry.ts"

class ProbeTag extends Context.Tag("probe/ProbeTag")<ProbeTag, { readonly speaks: string }>() {}

// A fixture cube whose `create` contributes one layer -- the same door the auth cube uses
// (`layers: AuthorizationLive`). One inert route so the group is a real `HttpApiGroup`.
const fixture = defineCube(
  HttpApiGroup.make("fixture").add(HttpApiEndpoint.get("ping")`/fixture/ping`.addSuccess(Schema.String)),
  {
    manifest: { name: "fixture", tables: [], requiresAuth: true },
    create: () => ({
      handlers: { ping: () => Effect.succeed("pong") },
      layers: Layer.succeed(ProbeTag, { speaks: "provided" }),
    }),
  },
)

const parts = fixture.create({
  store: {
    all: () => Effect.succeed([]),
    page: () => Effect.succeed({ rows: [], total: 0, offset: 0, limit: 0, sortedBy: "createdAt" }),
    byId: () => Effect.succeed(undefined),
    insert: () => Effect.die("not exercised"),
    update: () => Effect.die("not exercised"),
    count: () => Effect.succeed(0),
  },
  bus: { publish: () => Effect.void },
  catalogue: () => [],
  permissions: () => new Map(),
  commands: () => [],
})

// The type probe: this is the exact shape main.ts reads off a mounted cube
// (`MountedCube.parts.layers`, filter predicate included). If the contract drifts --
// the Provided side stops being erased to `never`, the error channel stops being
// `unknown`, or the requirement stops being bounded to `Registry` -- this line stops
// compiling, and `main.ts`'s cast-free composition stops being true.
const asMainSeesIt = (mounted: MountedCube): Layer.Layer<never, unknown, Registry> | undefined => mounted.parts.layers

const registry = Layer.succeed(Registry, {
  summary: () => Effect.succeed(null),
} as unknown as Context.Tag.Service<typeof Registry>)

describe("the kernel's layer composition stays cast-free and serving (QWB-38)", () => {
  it("a cube layer, composed the way main.ts composes it, provides its service", async () => {
    const layer = asMainSeesIt({
      manifest: fixture.manifest,
      name: "fixture",
      parts,
      plugin: null,
      commands: [],
    })
    assert.ok(layer, "the fixture cube must contribute a layer, or this probe proves nothing")
    // The three steps of main.ts, in order: registry provided back, error channel closed
    // (the former cast's job, now done honestly by orDie), then the merge. The Provided side
    // is erased to `never` exactly as discovery erases it, so the served tag is recovered
    // the same way the running server recovers it: by trusting the composition, and
    // failing the test the day the trust is broken.
    const composed = layer.pipe(Layer.provide(registry), Layer.orDie) as Layer.Layer<ProbeTag, never, never>
    const served = await Effect.runPromise(
      Effect.gen(function* () {
        return (yield* ProbeTag).speaks
      }).pipe(Effect.provide(Layer.mergeAll(composed))),
    )
    assert.equal(served, "provided")
  })
})
