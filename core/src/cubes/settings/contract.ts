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
