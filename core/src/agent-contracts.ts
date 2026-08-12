import { Schema } from "effect"

export const AgentHealth = Schema.Struct({
  cube: Schema.String,
  state: Schema.Literal("ready"),
  activegraph: Schema.String,
  llm: Schema.Boolean,
}).annotations({ identifier: "AgentHealth" })

export const AgentContext = Schema.Struct({
  cube: Schema.String,
  allowed: Schema.Array(Schema.String),
  crossCube: Schema.Boolean,
}).annotations({ identifier: "AgentContext" })

export const AgentGoalPayload = Schema.Struct({ goal: Schema.String }).annotations({ identifier: "AgentGoalPayload" })

export const AgentGoalResult = Schema.Struct({
  cube: Schema.String,
  state: Schema.Literal("idle"),
  goal: Schema.String,
  answer: Schema.String,
  model: Schema.String,
  usage: Schema.Struct({ promptTokens: Schema.Number, completionTokens: Schema.Number }),
  object: Schema.Struct({ type: Schema.String, cube: Schema.String, text: Schema.String }),
  llm: Schema.Literal(true),
}).annotations({ identifier: "AgentGoalResult" })

export const AgentTrace = Schema.Struct({
  cube: Schema.String,
  runId: Schema.NullOr(Schema.String),
  state: Schema.String,
  events: Schema.Array(Schema.Struct({ id: Schema.String, type: Schema.String, actor: Schema.String })),
}).annotations({ identifier: "AgentTrace" })
