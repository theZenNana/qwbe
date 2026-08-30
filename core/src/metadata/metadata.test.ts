// Unit tests for derived cube metadata: the field list must come from the REAL contract
// schema, never from a hand-written copy. The fixture here is a real HttpApiGroup, the same
// shape a cube ships.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Schema } from "effect"
import { deriveCubeMetadata } from "./metadata.ts"

const EntityMeta = { id: Schema.String, type: Schema.String, createdAt: Schema.String, deleted: Schema.Boolean }

const Thing = Schema.Struct({
  ...EntityMeta,
  name: Schema.String,
  count: Schema.Int,
  role: Schema.Literal("admin", "reader"),
  note: Schema.NullOr(Schema.String),
}).annotations({ identifier: "Thing" })

const ThingCreate = Schema.Struct({
  name: Schema.String,
  count: Schema.optionalWith(Schema.Int, { default: () => 0 }),
  note: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
}).annotations({ identifier: "ThingCreate" })

const group = HttpApiGroup.make("things")
  .add(HttpApiEndpoint.get("list")`/things`.addSuccess(Schema.Struct({ rows: Schema.Array(Thing), total: Schema.Int })))
  .add(HttpApiEndpoint.get("get")`/things/${HttpApiSchema.param("id", Schema.String)}`.addSuccess(Thing))
  .add(HttpApiEndpoint.post("create")`/things`.setPayload(ThingCreate).addSuccess(Thing))

const mount = (manifestOverrides: Record<string, unknown> = {}) => {
  const parts = { group, handlers: {}, relational: manifestOverrides.search as never }
  return {
    manifest: {
      name: "things",
      tables: ["things"],
      requiresAuth: true,
      ...manifestOverrides,
    },
    name: "things",
    parts,
    plugin: null,
    commands: [],
  }
}

describe("deriveCubeMetadata", () => {
  it("derives every field from the schema, including the meta columns", () => {
    const md = deriveCubeMetadata(mount() as never, [], [])
    assert.ok(md)
    assert.deepEqual(
      md.fields.map((f) => f.name),
      ["id", "type", "createdAt", "deleted", "name", "count", "role", "note"],
    )
  })

  it("classifies types, nullability and enum options from the AST", () => {
    const md = deriveCubeMetadata(mount() as never, [], [])
    assert.ok(md)
    const byName = new Map(md.fields.map((f) => [f.name, f]))
    assert.equal(byName.get("count")!.type, "integer")
    assert.equal(byName.get("note")!.nullable, true)
    assert.deepEqual(byName.get("role")!.enum, ["admin", "reader"])
    assert.equal(byName.get("name")!.type, "string")
  })

  it("takes required and editable from the CREATE payload, not the entity schema", () => {
    const md = deriveCubeMetadata(mount() as never, [], [])
    assert.ok(md)
    const byName = new Map(md.fields.map((f) => [f.name, f]))
    // name is required on create; count and note have defaults -> editable but not required.
    assert.equal(byName.get("name")!.required, true)
    assert.equal(byName.get("count")!.required, false)
    assert.equal(byName.get("count")!.editable, true)
    // meta columns are never caller-settable.
    assert.equal(byName.get("id")!.editable, false)
    assert.equal(byName.get("createdAt")!.editable, false)
  })

  it("defaults sortable to the meta columns, and nothing is searchable without a link", () => {
    const md = deriveCubeMetadata(mount() as never, [], [])
    assert.ok(md)
    const byName = new Map(md.fields.map((f) => [f.name, f]))
    assert.equal(byName.get("createdAt")!.sortable, true)
    assert.equal(byName.get("name")!.sortable, false)
    // No space link reaches this cube -> nothing is searchable, even with search implemented.
    const searching = mount({ search: { search: () => undefined as never } }) as never
    const withSearch = deriveCubeMetadata(searching, [], [])
    assert.ok(withSearch)
    assert.equal(
      withSearch.fields.every((f) => !f.searchable),
      true,
    )
  })

  it("defaults searchable to the cube's space-link fields when the cube searches", () => {
    // The only search route is GET /links/{entity}/{id}/{cube}: rows of this cube whose LINK
    // FIELD equals {id}. So the usable fields are the link fields -- here `name` -- and a text
    // field no link reaches (`note`) must not advertise itself as searchable.
    const searching = mount({ search: { search: () => undefined as never } }) as never
    const md = deriveCubeMetadata(searching, [], [{ from: "things", field: "name", to: "Other" }])
    assert.ok(md)
    const byName = new Map(md.fields.map((f) => [f.name, f]))
    assert.equal(byName.get("name")!.searchable, true)
    assert.equal(byName.get("note")!.searchable, false)
    assert.equal(byName.get("count")!.searchable, false)
  })

  it("honours manifest declarations: sortable, searchable, labels and version", () => {
    const md = deriveCubeMetadata(
      mount({
        sortable: ["name"],
        searchable: ["note"],
        version: "2.0.0",
        fields: { name: { label: "Thing name" } },
      }) as never,
      [],
      [],
    )
    assert.ok(md)
    const byName = new Map(md.fields.map((f) => [f.name, f]))
    assert.equal(byName.get("name")!.sortable, true)
    assert.equal(byName.get("note")!.searchable, true)
    assert.equal(byName.get("name")!.label, "Thing name")
    assert.equal(byName.get("count")!.label, "Count")
    assert.equal(md.version, "2.0.0")
  })

  it("derives labels from field names when the manifest declares none", () => {
    const md = deriveCubeMetadata(mount() as never, [], [])
    assert.ok(md)
    assert.equal(md.fields.find((f) => f.name === "createdAt")!.label, "Created At")
  })

  it("publishes a relation with the target cube, entity and summaryById", () => {
    const target = {
      manifest: { name: "other", tables: [], requiresAuth: true, entity: "Other" },
      name: "other",
      parts: { group, handlers: {}, relational: { summaryById: () => undefined as never } },
      plugin: null,
      commands: [],
    }
    const owner = mount({ relations: { name: { target: "other" } } }) as never
    const md = deriveCubeMetadata(owner, [owner, target], [])
    assert.ok(md)
    assert.deepEqual(md.fields.find((f) => f.name === "name")!.relation, {
      target: "other",
      entity: "Other",
      summary: "summaryById",
    })
  })

  it("uses a space link as the relation source when the manifest declares none", () => {
    const target = {
      manifest: { name: "other", tables: [], requiresAuth: true, entity: "Other" },
      name: "other",
      parts: { group, handlers: {}, relational: { summaryById: () => undefined as never } },
      plugin: null,
      commands: [],
    }
    const owner = mount() as never
    const md = deriveCubeMetadata(owner, [owner, target], [{ from: "things", field: "name", to: "Other" }])
    assert.ok(md)
    assert.equal(md.fields.find((f) => f.name === "name")!.relation!.target, "other")
  })

  it("changes the schemaHash when a field changes", () => {
    const before = deriveCubeMetadata(mount() as never, [], [])!
    const other = mount({ fields: { name: { label: "Renamed" } } }) as never
    const after = deriveCubeMetadata(other, [], [])!
    assert.notEqual(before.schemaHash, after.schemaHash)
  })

  it("returns undefined for a cube whose contract has no entity schema", () => {
    const bare = {
      manifest: { name: "bare", tables: [], requiresAuth: true },
      name: "bare",
      parts: { group: HttpApiGroup.make("bare").add(HttpApiEndpoint.get("ping")`/bare`.addSuccess(Schema.String)) },
      plugin: null,
      commands: [],
    }
    assert.equal(deriveCubeMetadata(bare as never, [], []), undefined)
  })
})
