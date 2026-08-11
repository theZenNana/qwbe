import { HttpApiSchema } from "@effect/platform"
import { Schema } from "effect"

export { AgentContext, AgentGoalPayload, AgentGoalResult, AgentHealth, AgentTrace } from "qwbe-core/agent"

export class AgentUnavailable extends Schema.TaggedError<AgentUnavailable>()(
  "AgentUnavailable",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 503 }),
) {}
