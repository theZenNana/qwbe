// The catalogue must derive metadata ONCE per distinct set of mounted cubes -- not once per
// cube, and not once per catalogue() call. `GET /settings/cubes` builds the catalogue several
// times per request; a full AST walk plus sha256 per call would multiply that cost.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Schema } from "effect"
import { buildCatalogue, metadataDerivations } from "./catalogue.ts"

const Entity = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  createdAt: Schema.String,
  deleted: Schema.Boolean,
  name: Schema.String,
})

const entityGroup = HttpApiGroup.make("things")
  .add(
    HttpApiEndpoint.get("list")`/things`.addSuccess(Schema.Struct({ rows: Schema.Array(Entity), total: Schema.Int })),
  )
  .add(HttpApiEndpoint.get("get")`/things/${HttpApiSchema.param("id", Schema.String)}`.addSuccess(Entity))
  .add(HttpApiEndpoint.post("create")`/things`.setPayload(Schema.Struct({ name: Schema.String })).addSuccess(Entity))

const bareGroup = HttpApiGroup.make("bare").add(HttpApiEndpoint.get("ping")`/bare`.addSuccess(Schema.String))

const mounted = (name: string, group: unknown) => ({
  name,
  plugin: null,
  manifest: { name, tables: [name], requiresAuth: true, publishes: [] as string[] },
  cube: { name, parts: { group } },
})

const definitions = () => [mounted("things", entityGroup), mounted("bare", bareGroup), mounted("cli", bareGroup)]

describe("buildCatalogue metadata derivation", () => {
  it("derives once for a multi-cube catalogue and caches the negative result too", () => {
    // Fresh parts objects: a WeakMap keyed by parts must not serve a previous test's entries.
    const defs = definitions()
    const before = metadataDerivations.count
    const catalogue = buildCatalogue(
      defs,
      () => true,
      () => undefined,
      [],
    )
    assert.equal(metadataDerivations.count, before + 1)
    assert.ok(catalogue.find((c) => c.name === "things")?.metadata)
    assert.equal(catalogue.find((c) => c.name === "bare")?.metadata, undefined)

    // A second build over the SAME mounted cubes derives nothing: every result, including the
    // absent one for `bare`, is already cached by its parts object.
    buildCatalogue(
      defs,
      () => true,
      () => undefined,
      [],
    )
    assert.equal(metadataDerivations.count, before + 1)
  })

  it("keeps two mounts of the same cube name from sharing a cache entry", () => {
    const before = metadataDerivations.count
    const first = buildCatalogue(
      definitions(),
      () => true,
      () => undefined,
      [],
    )
    const second = buildCatalogue(
      definitions(),
      () => true,
      () => undefined,
      [],
    )
    assert.ok(second.find((c) => c.name === "things")?.metadata)
    assert.equal(first.find((c) => c.name === "things")?.metadata?.cube, "things")
    // Two independent mounts: two derivations, one per distinct set of parts.
    assert.equal(metadataDerivations.count, before + 2)
  })
})
