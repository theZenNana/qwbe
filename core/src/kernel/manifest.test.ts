// Unit tests for manifest validation — the gate that stops a cube from lying about itself.
//
// Every rule here was written after a specific hole: a cube called `notes:evil` whose commands
// were routed to `notes`, a cube granting itself `account:write`, a command declared twice where
// the second silently vanished. The tests keep the holes closed.

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { Effect, Schema } from "effect"

import { Authorization } from "./auth-contract.ts"
import { Forbidden } from "./errors.ts"
import type { CommandSpec, Manifest, PermissionSpec } from "./manifest.ts"
import { InvalidManifestError, validateCommands, validateManifest, validateRoutes } from "./manifest-validation.ts"

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

describe("validateRoutes", () => {
  // A real group, the same shape a cube ships: the gate must read the routes that will run.
  // Behind Authorization with 403 on the schema, exactly what a declared permission demands.
  const group = HttpApiGroup.make("notes")
    .add(HttpApiEndpoint.get("list")`/notes`.addSuccess(Schema.String).addError(Forbidden))
    .add(HttpApiEndpoint.get("get")`/notes/id`.addSuccess(Schema.String).addError(Forbidden))
    .middleware(Authorization)

  // The mutating half of the surface (QWB-54, 14c): POST behind Authorization, carrying the
  // 403 the enforcement answers -- the shape every real cube's write endpoint has. The list
  // rides along behind Authorization with its 403, because the convention's derived read
  // permission gets the same checks a declared one does.
  const mutatingGroup = HttpApiGroup.make("notes")
    .add(HttpApiEndpoint.get("list")`/notes`.addSuccess(Schema.String).addError(Forbidden))
    .add(HttpApiEndpoint.post("create")`/notes`.addSuccess(Schema.String).addError(Forbidden).middleware(Authorization))
    .middleware(Authorization)

  const withRoutes = (routes: Record<string, string | null>, permissions = grants("notes:read", "notes:write")) => ({
    ...manifest({ permissions }),
    routes,
  })

  it("accepts routes that exist, backed by declared permissions", () => {
    assert.doesNotThrow(() => validateRoutes(withRoutes({ list: "notes:read", get: "notes:read" }), group))
  })

  it("accepts a cube that declares no routes when nothing sits behind Authorization", () => {
    // Rule 1 gates exactly the endpoints behind Authorization; a public surface declares no
    // permission to enforce, so no routes entry can be forgotten. No `list` endpoint here:
    // an undeclared list is never free -- the convention's checks below gate it even when it
    // is public. (`mount.ts` separately refuses a public endpoint on any cube but `auth`.)
    const publicGroup = HttpApiGroup.make("notes").add(HttpApiEndpoint.get("get")`/notes/id`.addSuccess(Schema.String))
    assert.doesNotThrow(() => validateRoutes(manifest({ permissions: grants("notes:read") }), publicGroup))
  })

  it("refuses a route the cube does not serve -- the metadata would publish a route that runs nowhere", () => {
    assert.throws(
      () => validateRoutes(withRoutes({ backdoor: "notes:read" }), group),
      /route "backdoor" is not an endpoint/,
    )
  })

  it("refuses a permission the cube never declares -- a rename in `permissions` without this gate would mount a cube publishing a name no token can hold", () => {
    assert.throws(
      () => validateRoutes(withRoutes({ list: "notes:admin" }), group),
      /route "list" requires permission "notes:admin", which this cube does not declare/,
    )
  })

  it("a mutating endpoint behind Authorization without a routes entry is refused at boot", () => {
    assert.throws(
      () => validateRoutes(manifest({ permissions: grants("notes:write") }), mutatingGroup),
      /route "create" \(POST\) is behind Authorization but declares no permission/,
    )
  })

  it("an explicit null is the opt-out: the handler decides per request", () => {
    assert.doesNotThrow(() => validateRoutes(withRoutes({ create: null }), mutatingGroup))
  })

  it("a routed endpoint whose error schema has no 403 is refused", () => {
    // Same endpoint, but no Forbidden in the contract: the wrapper's 403 would be a status
    // the route never answers with, so the declaration is a lie.
    const no403 = HttpApiGroup.make("notes")
      .add(HttpApiEndpoint.get("list")`/notes`.addSuccess(Schema.String))
      .add(HttpApiEndpoint.post("create")`/notes`.addSuccess(Schema.String).middleware(Authorization))
    assert.throws(
      () => validateRoutes(withRoutes({ create: "notes:write" }), no403),
      /route "create" declares permission "notes:write" but its error schema has no 403/,
    )
  })

  it("list may not opt out -- the kernel's read convention applies", () => {
    assert.throws(() => validateRoutes(withRoutes({ list: null }), group), /route "list" may not opt out/)
  })

  // --- the three edges the review found in the boot gate (QWB-54, 14c) ---------------------------

  // The hostile fixture shape (probes/fixtures/permission-bypass): a cube that declares NO
  // permissions at all. While rule 1 ran only for cubes with permissions, this shape slipped
  // every gate.
  const hostileGroup = HttpApiGroup.make("hostile")
    .add(
      HttpApiEndpoint.get("get")`/hostile/id`.addSuccess(Schema.String).addError(Forbidden).middleware(Authorization),
    )
    .add(
      HttpApiEndpoint.post("create")`/hostile`.addSuccess(Schema.String).addError(Forbidden).middleware(Authorization),
    )

  it("rule 1 runs for a cube that declares no permissions at all", () => {
    assert.throws(() => validateRoutes(manifest(), hostileGroup), /route "create" \(POST\) is behind Authorization/)
  })

  it("a permissionless cube opts every gated route out explicitly, with nulls", () => {
    // A permissionless cube cannot declare a permission (own.has would refuse it), so `null`
    // is its only honest declaration -- the explicit opt-out, never the silent default.
    assert.doesNotThrow(() => validateRoutes({ ...manifest(), routes: { get: null, create: null } }, hostileGroup))
  })

  it("a GET endpoint behind Authorization without a routes entry is refused too", () => {
    // The old gate skipped GETs entirely: an unguarded `get` or report endpoint read rows to
    // any authenticated caller. `list` is the one exemption -- it rides the convention below.
    assert.throws(() => validateRoutes(withRoutes({}), group), /route "get" \(GET\) is behind Authorization/)
  })

  it("an undeclared list serves notes:read by convention, which the cube must declare", () => {
    // The wrapper derives `notes:read` for the undeclared list at runtime; a cube that never
    // declared it would 403 for everyone. Refused at boot instead.
    assert.throws(
      () => validateRoutes(manifest({ permissions: grants("notes:write") }), mutatingGroup),
      /list serves permission "notes:read" by convention, which this cube does not declare/,
    )
  })

  it("an undeclared list must still sit behind Authorization", () => {
    const bareList = HttpApiGroup.make("notes")
      .add(HttpApiEndpoint.get("list")`/notes`.addSuccess(Schema.String).addError(Forbidden))
      .add(
        HttpApiEndpoint.post("create")`/notes`.addSuccess(Schema.String).addError(Forbidden).middleware(Authorization),
      )
    assert.throws(
      () => validateRoutes(withRoutes({ create: "notes:write" }), bareList),
      /route "list" serves permission "notes:read" by convention but nothing on it requires Authorization/,
    )
  })

  it("an undeclared list must publish the 403 the convention's enforcement answers", () => {
    const no403List = HttpApiGroup.make("notes")
      .add(HttpApiEndpoint.get("list")`/notes`.addSuccess(Schema.String).middleware(Authorization))
      .add(
        HttpApiEndpoint.post("create")`/notes`.addSuccess(Schema.String).addError(Forbidden).middleware(Authorization),
      )
    assert.throws(
      () => validateRoutes(withRoutes({ create: "notes:write" }), no403List),
      /route "list" serves permission "notes:read" by convention but its error schema has no 403/,
    )
  })

  it("the convention shape passes: undeclared list, read declared, auth and 403 on the route", () => {
    const listOnly = HttpApiGroup.make("notes")
      .add(HttpApiEndpoint.get("list")`/notes`.addSuccess(Schema.String).addError(Forbidden))
      .middleware(Authorization)
    assert.doesNotThrow(() => validateRoutes(withRoutes({}), listOnly))
  })
})
