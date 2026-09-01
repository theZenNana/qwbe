// Unit tests for the migration ownership rules (QWB-54 ticket 08). Since the ticket the
// checks are pure -- the "inert escape" that skipped provenance when the source schema was
// absent is gone -- so every rule here is provable without a database: the ledger snapshot
// and the mounted set are all the function sees.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Ledger } from "./ledger.ts"
import type { DataMigration, Manifest } from "./manifest.ts"
import { checkMigrationOwnership, MigrationOwnershipError } from "./migrate-ownership.ts"

const definition = (name: string, plugin: string | null, manifest: Partial<Manifest> = {}) => ({
  name,
  plugin,
  definition: { manifest: { name, tables: [], requiresAuth: false, ...manifest } as Manifest },
})

const migrate = (fromCube: string, toCube: string, fromPlugin?: string | null): Partial<Manifest> => ({
  dataMigration: [
    fromPlugin === undefined
      ? // The shape a plain-JS cube can produce with the key omitted entirely: the type
        // would refuse it, imported code does not -- which is exactly the path under test.
        ({ fromCube, toCube } as unknown as DataMigration)
      : { fromCube, toCube, fromPlugin },
  ],
})

const run = async (definitions: Parameters<typeof checkMigrationOwnership>[0], ledger: Ledger) =>
  checkMigrationOwnership(definitions, ledger)

describe("migration ownership -- the registry of known cubes", () => {
  it("refuses a source the kernel has never recorded, even with no schema anywhere", async () => {
    // The invented-source lie (QWB-54 ticket 08): a declaration aimed at a cube that never
    // existed must not survive because no schema happens to exist under its name either.
    const definitions = [
      definition("crm/organizations", "crm-pack", migrate("organizations", "crm/organizations", "crm-pack")),
    ]
    await assert.rejects(
      () => run(definitions, {}),
      (e: unknown) => e instanceof MigrationOwnershipError && e.message.includes(`no record of "organizations"`),
    )
  })

  it("passes a source the ledger records under the claimed package", async () => {
    const definitions = [definition("crm/contacts", "crm-pack", migrate("contacts", "crm/contacts", "crm-pack"))]
    const out = await run(definitions, { contacts: "crm-pack" })
    assert.equal(out.length, 1)
    assert.equal(out[0]?.fromCube, "contacts")
    // The declaring package rides along: main.ts records it, keeping the source attributable
    // after the migration completed and its schema is gone.
    assert.equal(out[0]?.declaredBy, "crm-pack")
  })

  it("refuses a source whose ledger record names another package", async () => {
    const definitions = [definition("evil", "evil-pack", migrate("auth", "evil", "evil-pack"))]
    await assert.rejects(() => run(definitions, { auth: null }), /ledger records/)
  })

  it("passes a completed migration by its ledger record alone -- no schema, no operator env", async () => {
    // The restart case: boot one renamed the schema away; boot two must not need
    // QWBE_LEGACY_MIGRATIONS, because the ledger now holds the migration's source.
    const definitions = [
      definition("booktags/tags", "example-plugin", migrate("tags", "booktags/tags", "example-plugin")),
    ]
    const out = await run(definitions, { tags: "example-plugin", "booktags/tags": "example-plugin" })
    assert.equal(out.length, 1)
  })

  it("passes a pre-ledger source only with the operator's explicit authorization", async () => {
    const definitions = [
      definition("booktags/tags", "example-plugin", migrate("tags", "booktags/tags", "example-plugin")),
    ]
    const previous = process.env.QWBE_LEGACY_MIGRATIONS
    try {
      process.env.QWBE_LEGACY_MIGRATIONS = "tags:example-plugin"
      const out = await run(definitions, {})
      assert.equal(out.length, 1)
    } finally {
      if (previous === undefined) delete process.env.QWBE_LEGACY_MIGRATIONS
      else process.env.QWBE_LEGACY_MIGRATIONS = previous
    }
  })

  it("refuses a source that is a mounted cube of ANOTHER package", async () => {
    const definitions = [
      definition("auth", null),
      definition("evil", "evil-pack", migrate("auth", "evil", "evil-pack")),
    ]
    await assert.rejects(() => run(definitions, { auth: null }), /live, not legacy/)
  })

  it("refuses a destination that is not mounted, or belongs to another package", async () => {
    const unmounted = [definition("other", "crm-pack", migrate("contacts", "crm/contacts", "crm-pack"))]
    await assert.rejects(() => run(unmounted, { contacts: "crm-pack" }), /is not mounted/)

    const foreign = [
      definition("crm/contacts", "crm-pack"),
      definition("evil", "evil-pack", migrate("contacts", "crm/contacts", "evil-pack")),
    ]
    await assert.rejects(() => run(foreign, { contacts: "crm-pack" }), /belongs to plugin "crm-pack"/)
  })

  it("refuses a source with no provenance claimed at all", async () => {
    const definitions = [definition("evil", "evil-pack", migrate("somewhere", "evil"))]
    await assert.rejects(() => run(definitions, {}), /without naming the source package/)
  })
})
