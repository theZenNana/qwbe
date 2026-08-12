import { resolve } from "node:path"
import { Command, type CommandExecutor } from "@effect/platform"
import { Effect, Schema } from "effect"
import { AgentUnavailable } from "./agent-contract.ts"

const pluginDir = import.meta.dirname
const script = resolve(pluginDir, "agent.py")
const python = process.env.QWBE_ACTIVEGRAPH_PYTHON ?? resolve(pluginDir, "../../../.qwb-activegraph-venv/bin/python")
const data =
  process.env.QWBE_AGENTLAB_DATA ??
  resolve(process.env.QWBE_DATA_DIR ?? resolve(pluginDir, "../../../data"), "agentlab")
const PROCESS_TIMEOUT_MS = 5_000
const GOAL_TIMEOUT_MS = 90_000
const processLock = Effect.unsafeMakeSemaphore(1)

const unavailable = (message: string) => new AgentUnavailable({ message })
const ProcessFailure = Schema.Struct({ error: Schema.String })

export const invokeAgent = <A, I>(
  command: "health" | "context" | "goal" | "trace",
  payload: object,
  schema: Schema.Schema<A, I, never>,
): Effect.Effect<A, AgentUnavailable, CommandExecutor.CommandExecutor> =>
  processLock.withPermits(1)(
    Command.make(python, script, command).pipe(
      Command.env({ ...process.env, QWBE_AGENT_CUBE: "agentlab", QWBE_AGENT_DATA: data }),
      Command.feed(JSON.stringify(payload)),
      Command.string,
      Effect.timeoutFail({
        duration: command === "goal" ? GOAL_TIMEOUT_MS : PROCESS_TIMEOUT_MS,
        onTimeout: () => unavailable(`ActiveGraph ${command} timed out`),
      }),
      Effect.mapError((error) =>
        error instanceof AgentUnavailable ? error : unavailable(`ActiveGraph process failed: ${error.message}`),
      ),
      Effect.flatMap((stdout) =>
        Effect.try({
          try: () => JSON.parse(stdout) as unknown,
          catch: () => unavailable("ActiveGraph returned malformed JSON"),
        }),
      ),
      Effect.flatMap((body) =>
        Schema.is(ProcessFailure)(body) ? Effect.fail(unavailable(body.error)) : Effect.succeed(body),
      ),
      Effect.flatMap(Schema.decodeUnknown(schema)),
      Effect.mapError((error) =>
        error instanceof AgentUnavailable
          ? error
          : unavailable(`ActiveGraph response violated its contract: ${error.message}`),
      ),
    ),
  )
