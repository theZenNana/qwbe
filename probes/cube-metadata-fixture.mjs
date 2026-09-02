// Fixture cube for the cube-metadata probe: a real plugin directory, generated so the probe
// can CHANGE its schema mid-run -- a committed fixture could not. `extraField` appends a field
// to the entity; `version` is what the drift gate compares.
//
// The directory lives inside core/plugins (gitignored), which means a probe killed hard would
// otherwise leave a bogus cube behind that every later dev boot mounts and records in the
// provenance ledger. So the FIRST thing the probe does is sweep the path -- a stale leftover
// from a killed run is exactly what a restart of the probe must remove, and the fixture name
// is owned by this probe alone.
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const fixtureRoot = join(import.meta.dirname, "..", "core", "plugins", "meta-drift-fixture")
const fixtureCube = join(fixtureRoot, "cubes", "metadrift")

/** Remove the fixture whether or not this run planted it. Safe to call at any time. */
export const sweepFixture = () => rmSync(fixtureRoot, { recursive: true, force: true })

const fixtureSource = (
  extraField,
  version,
) => `import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization } from "qwbe-core/auth"
import { Forbidden } from "qwbe-core/errors"

const Thing = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  createdAt: Schema.String,
  deleted: Schema.Boolean,
  name: Schema.String${extraField}
}).annotations({ identifier: "MetadriftThing" })

const group = HttpApiGroup.make("metadrift")
  .add(HttpApiEndpoint.get("list")\`/metadrift\`.addSuccess(Schema.Struct({ rows: Schema.Array(Thing), total: Schema.Int })))
  .add(HttpApiEndpoint.get("get")\`/metadrift/\${HttpApiSchema.param("id", Schema.String)}\`.addSuccess(Thing).addError(Forbidden))
  .middleware(Authorization)

export const cube = {
  manifest: {
    name: "metadrift",
    tables: ["metadrift"],
    requiresAuth: true,
    version: "${version}",
    permissions: [{ name: "metadrift:read", roles: ["admin", "reader"] }],
  },
  create: () => ({
    group,
    handlers: {
      list: () => Effect.succeed({ rows: [], total: 0 }),
      get: () => Effect.succeed({ id: "x", type: "MetadriftThing", createdAt: "", deleted: false, name: "n"${extraField ? ", flag: true" : ""} }),
    },
  }),
}
`

export const writeFixture = (extraField, version) => {
  rmSync(fixtureRoot, { recursive: true, force: true })
  mkdirSync(fixtureCube, { recursive: true })
  // The kernel checks the package contract of every plugin it mounts (QWB-54), so the fixture
  // ships the manifest a real package ships -- otherwise the boot it is testing never happens.
  writeFileSync(
    join(fixtureRoot, "qwbe-package.json"),
    `${JSON.stringify({ name: "meta-drift-fixture", kind: "plugin", cubes: ["metadrift"] }, null, 2)}\n`,
    "utf8",
  )
  writeFileSync(join(fixtureCube, "index.ts"), fixtureSource(extraField, version), "utf8")
}

export const dropFixture = () => rmSync(fixtureRoot, { recursive: true, force: true })
