// Unit tests for manifest validation — the gate that stops a cube from lying about itself.
//
// Every rule here was written after a specific hole: a cube called `notes:evil` whose commands
// were routed to `notes`, a cube granting itself `account:write`, a command declared twice where
// the second silently vanished. The tests keep the holes closed.

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Effect } from "effect"

import type { CommandSpec, Manifest, PermissionSpec } from "./manifest.ts"
import { InvalidManifestError, validateCommands, validateManifest } from "./manifest-validation.ts"

const manifest = (over: Partial<Manifest> = {}): Manifest => ({
  name: "notes",
  tables: ["notes"],
  requiresAuth: true,
  ...over,
})

const grants = (...names: ReadonlyArray<string>): ReadonlyArray<PermissionSpec> =>
  names.map((name) => ({ name, roles: ["admin"] }))

// `run` is never called here — validation reads names and permissions, not behaviour.
const command = (over: Partial<CommandSpec> = {}): CommandSpec => ({
  name: "notes:list",
  permission: "notes:read",
  summary: "list notes",
  run: () => Effect.succeed(""),
  ...over,
})

describe("validateManifest — the name must be the directory's", () => {
  it("accepts a manifest whose name matches its directory", () => {
    assert.doesNotThrow(() => validateManifest("notes", manifest()))
  })

  it("refuses a name that differs from the directory", () => {
    assert.throws(() => validateManifest("notes", manifest({ name: "account" })), InvalidManifestError)
  })

  it("names the mismatch in the message, so the fix is obvious", () => {
    assert.throws(
      () => validateManifest("notes", manifest({ name: "account" })),
      /name is "account" but the directory is "notes"/,
    )
  })

  it("requires a hierarchy child to declare its leaf name, not the composed identity", () => {
    assert.doesNotThrow(() => validateManifest("contacts", manifest({ name: "contacts", parent: "crm" })))
    assert.throws(
      () => validateManifest("contacts", manifest({ name: "crm/contacts", parent: "crm" })),
      /name is "crm\/contacts" but the directory is "contacts"/,
    )
  })
})

describe("validateManifest — the name must be a plain lowercase slug", () => {
  it("accepts letters, digits and dashes", () => {
    assert.doesNotThrow(() => validateManifest("erp-settings", manifest({ name: "erp-settings" })))
    assert.doesNotThrow(() => validateManifest("cube2", manifest({ name: "cube2" })))
  })

  // The one that mattered: `notes:evil` had its commands routed to the `notes` switch, so
  // switching it off in Settings left them running.
  it("refuses a colon in the name", () => {
    assert.throws(() => validateManifest("notes:evil", manifest({ name: "notes:evil" })), /must match/)
  })

  it("refuses uppercase, a leading digit, and a leading dash", () => {
    for (const name of ["Notes", "2notes", "-notes", "no_tes", "no tes", ""]) {
      assert.throws(() => validateManifest(name, manifest({ name })), InvalidManifestError, `"${name}" must be refused`)
    }
  })
})

describe("validateManifest — permissions belong to the cube declaring them", () => {
  it("accepts a permission under the cube's own prefix", () => {
    assert.doesNotThrow(() => validateManifest("notes", manifest({ permissions: grants("notes:read") })))
  })

  it("refuses a cube granting itself another cube's permission", () => {
    assert.throws(
      () => validateManifest("notes", manifest({ permissions: grants("account:write") })),
      /permission "account:write" does not start with "notes:"/,
    )
  })
})

describe("validateManifest — an entity needs a table to live in", () => {
  it("refuses an entity declared by a cube that owns no tables", () => {
    assert.throws(
      () => validateManifest("notes", manifest({ tables: [], entity: "Note" })),
      /declares entity "Note" but owns no tables/,
    )
  })

  it("allows a cube with no tables and no entity", () => {
    assert.doesNotThrow(() => validateManifest("cli", manifest({ name: "cli", tables: [] })))
  })
})

describe("validateManifest — all reasons at once", () => {
  it("reports every problem in one throw instead of one per run", () => {
    const broken = manifest({
      name: "Notes:evil",
      tables: [],
      entity: "Note",
      permissions: grants("account:write"),
    })
    const error = (() => {
      try {
        validateManifest("notes", broken)
        return null
      } catch (e) {
        return e as Error
      }
    })()
    assert.ok(error, "a broken manifest must throw")
    for (const fragment of ["directory is", "must match", "owns no tables", "account:write"]) {
      assert.match(error.message, new RegExp(fragment))
    }
  })
})

describe("validateCommands", () => {
  const own = manifest({ permissions: grants("notes:read") })

  it("accepts a command prefixed by its cube and backed by a declared permission", () => {
    assert.doesNotThrow(() => validateCommands(own, [command()]))
  })

  it("accepts a cube with no commands", () => {
    assert.doesNotThrow(() => validateCommands(own, []))
  })

  it("refuses a command under another cube's prefix", () => {
    assert.throws(
      () => validateCommands(own, [command({ name: "account:list" })]),
      /command "account:list" does not start with "notes:"/,
    )
  })

  it("refuses a command asking for a permission the cube never declared", () => {
    assert.throws(
      () => validateCommands(own, [command({ permission: "notes:admin" })]),
      /requires permission "notes:admin", which this cube does not declare/,
    )
  })

  // The gate looks commands up with `Array.find`, so a duplicate used to be swallowed whole.
  it("refuses a command declared twice, which would otherwise be silently ignored", () => {
    assert.throws(() => validateCommands(own, [command(), command()]), /declared twice/)
  })
})
