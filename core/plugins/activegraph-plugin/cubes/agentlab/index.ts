import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { Effect } from "effect"
import { defineCube } from "qwbe-core/cube"
import { Authorization, requirePermission } from "../../../../src/kernel/auth-contract.ts"
import { Forbidden } from "../../../../src/kernel/errors.ts"
import {
  AgentContext,
  AgentGoalPayload,
  AgentGoalResult,
  AgentHealth,
  AgentTrace,
  AgentUnavailable,
} from "../../agent-contract.ts"
import { invokeAgent } from "../../runtime.ts"

const group = HttpApiGroup.make("agentlab")
  .add(
    HttpApiEndpoint.get("health")`/agentlab/health`
      .addSuccess(AgentHealth)
      .addError(AgentUnavailable)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.get("context")`/agentlab/context`
      .addSuccess(AgentContext)
      .addError(AgentUnavailable)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.post("goal")`/agentlab/goals`
      .setPayload(AgentGoalPayload)
      .addSuccess(AgentGoalResult)
      .addError(AgentUnavailable)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.get("trace")`/agentlab/trace`.addSuccess(AgentTrace).addError(AgentUnavailable).addError(Forbidden),
  )
  .middleware(Authorization)

export const cube = defineCube(group, {
  manifest: {
    name: "agentlab",
    tables: [],
    screen: false,
    agent: true,
    requiresAuth: true,
    permissions: [
      { name: "agentlab:read", roles: ["admin", "reader"] },
      { name: "agentlab:run", roles: ["admin"] },
    ],
  },
  create: () => ({
    handlers: {
      health: () =>
        requirePermission("agentlab:read").pipe(Effect.flatMap(() => invokeAgent("health", {}, AgentHealth))),
      context: () =>
        requirePermission("agentlab:read").pipe(Effect.flatMap(() => invokeAgent("context", {}, AgentContext))),
      goal: ({ payload }: { payload: typeof AgentGoalPayload.Type }) =>
        requirePermission("agentlab:run").pipe(
          Effect.flatMap(() => invokeAgent("goal", { ...payload, cube: "agentlab" }, AgentGoalResult)),
        ),
      trace: () => requirePermission("agentlab:read").pipe(Effect.flatMap(() => invokeAgent("trace", {}, AgentTrace))),
    },
  }),
})
