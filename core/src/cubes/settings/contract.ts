import { Schema } from "effect"

export const CubeState = Schema.Struct({
  name: Schema.String,
  enabled: Schema.Boolean,
  required: Schema.Boolean,
  system: Schema.Boolean,
  /** Which plugin brought it, or null when it ships with core. */
  plugin: Schema.NullOr(Schema.String),
  /** Whether this mounted cube's directory still exists at the location discovered at startup. */
  onDisk: Schema.Boolean,
  entity: Schema.NullOr(Schema.String),
  /** A cube with a screen of its own but no entity; the sidebar links it just the same. */
  screen: Schema.Boolean,
  publishes: Schema.Array(Schema.String),
  links: Schema.Array(Schema.Struct({ to: Schema.String, field: Schema.String, label: Schema.String })),
}).annotations({ identifier: "CubeState" })

/** A package offered by the store, and whether it is already on disk. */
export const PackageState = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literal("cube", "plugin"),
  summary: Schema.String,
  /** For a plugin, the cubes it brings; for a cube, itself. */
  cubes: Schema.Array(Schema.String),
  installed: Schema.Boolean,
  bytes: Schema.Number,
  /**
   * Cube names this package would collide with, given what is on disk right now.
   *
   * In the contract rather than only enforced, so a client can grey the button out and say why
   * before the click. Two store packages both brought a cube called `contacts`; installing the
   * second was accepted, and the NEXT STARTUP died - the kernel refuses duplicate names, and
   * rightly. From a button in a web page, "the server will not come up" is the worst possible
   * way to learn that.
   */
  conflicts: Schema.Array(Schema.String),
}).annotations({ identifier: "PackageState" })

/**
 * The one place a caller may hand the system a path: install from a directory the
 * administrator points at. The kernel validates, stages and copies - see
 * `installer.stageAndInstall`. The payload carries nothing else, so there is nothing else
 * to abuse.
 */
export const InstallFromPayload = Schema.Struct({ path: Schema.String }).annotations({
  identifier: "InstallFromPayload",
})

export const InstallFromResult = Schema.Struct({
  package: PackageState,
  /** True when this call created the store copy; false when an identical one was reused. */
  staged: Schema.Boolean,
  requiresRestart: Schema.Boolean,
}).annotations({ identifier: "InstallFromResult" })
