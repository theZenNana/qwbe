// The GENERIC agent contract: what "this cube exposes an agent or another external runtime"
// means in Qwbe, once, for kernel, catalogue, API, web and every present or future plugin.
//
// The kernel knows nothing about what sits behind the surface -- a subprocess, an HTTP
// service, a model provider. A plugin declares the capability in its manifest (`agent: true`),
// serves the four routes below under its own prefix, and the shell draws the generic
// `/agent/<cube>` screen from this contract alone. Nothing cube- or runtime-specific may
// enter this file: the day a runtime name appears here, every plugin pays for one plugin's
// choice.

import { HttpApiSchema } from "@effect/platform"
import { Schema } from "effect"

/** The four routes a cube declaring `agent: true` MUST serve, relative to its prefix.
 *  Checked against the real endpoint list at mount -- see `validateAgentSurface` in
 *  `kernel/manifest.ts`. A cube cannot promise the button and skip the contract. */
export const AGENT_SURFACE = {
  health: { method: "GET", suffix: "health" },
  context: { method: "GET", suffix: "context" },
  goal: { method: "POST", suffix: "goals" },
  trace: { method: "GET", suffix: "trace" },
} as const

/** Coarse liveness of the runtime behind the cube. `ready` means the surface is usable;
 *  the other two states travel as a 503 `AgentUnavailable`, decoded by the web client into
 *  `unavailable` (cannot start / not configured) or `error` (answered, but broken). */
export const AgentHealth = Schema.Struct({
  cube: Schema.String,
  state: Schema.Literal("ready"),
  /** Free-form implementation self-description, e.g. "name 1.2.3". Opaque by design:
   *  the kernel displays it and never parses it. */
  runtime: Schema.String,
}).annotations({ identifier: "AgentHealth" })

/** What the agent may see, stated by the cube itself. The shell shows it so the boundary
 *  is visible, not just enforced. */
export const AgentContext = Schema.Struct({
  cube: Schema.String,
  allowed: Schema.Array(Schema.String),
  crossCube: Schema.Boolean,
}).annotations({ identifier: "AgentContext" })

export const AgentGoalPayload = Schema.Struct({ goal: Schema.String }).annotations({ identifier: "AgentGoalPayload" })

export const AgentGoalResult = Schema.Struct({
  cube: Schema.String,
  state: Schema.String,
  goal: Schema.String,
  answer: Schema.String,
  /** Present when the goal went through a model; absent for a deterministic runtime. */
  model: Schema.optional(Schema.String),
  usage: Schema.optional(Schema.Struct({ promptTokens: Schema.Number, completionTokens: Schema.Number })),
}).annotations({ identifier: "AgentGoalResult" })

export const AgentTrace = Schema.Struct({
  cube: Schema.String,
  runId: Schema.NullOr(Schema.String),
  state: Schema.String,
  events: Schema.Array(Schema.Struct({ id: Schema.String, type: Schema.String, actor: Schema.String })),
}).annotations({ identifier: "AgentTrace" })

/** The failure every agent surface reports with: 503, one message, no internals. */
export class AgentUnavailable extends Schema.TaggedError<AgentUnavailable>()(
  "AgentUnavailable",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 503 }),
) {}
