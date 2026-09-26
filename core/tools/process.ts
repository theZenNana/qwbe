import * as Command from "@effect/platform/Command"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

// Every tool spawns through this module. Under `npm run`, npm passes the user's allow-scripts as
// npm_config_allow_scripts, and a child npm >= 12 refuses it in a project (EALLOWSCRIPTS); the child
// reads ~/.npmrc itself, so dropping the variable keeps the policy. Children inherit process.env.
for (const key of Object.keys(process.env))
  if (key.toLowerCase() === "npm_config_allow_scripts") delete process.env[key]

export class GateFailed extends Data.TaggedError("GateFailed")<{
  readonly message: string
  readonly status: number
}> {}

export const capture = (command: Command.Command) =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* Command.start(command)
      const [status, stdout, stderr] = yield* Effect.all(
        [
          child.exitCode,
          child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        ],
        { concurrency: "unbounded" },
      )
      return { status, stdout, stderr }
    }),
  )

export const reportFailure = (error: GateFailed) =>
  Effect.gen(function* () {
    yield* Console.error(error.message)
    process.exitCode = error.status
  })
