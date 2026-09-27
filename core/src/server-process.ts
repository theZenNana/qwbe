// A kernel process owned by a scope: started, drained, waited on until it answers, and stopped
// when the scope closes. `qwbe check` boots the kernel under test through these, and the check
// suites boot theirs the same way.

import { Command, type CommandExecutor } from "@effect/platform"
import { Data, type Duration, Effect, Ref, Schedule, Stream } from "effect"
import { send } from "./api-client.ts"

export class ServerDidNotStart extends Data.TaggedError("ServerDidNotStart")<{
  readonly output: string
  /** The exit status when the process died before answering; null while it still runs or on a signal. */
  readonly exit: number | null
}> {
  override get message() {
    return `the server did not start; its output:\n${this.output}`
  }
}

// SIGTERM, then SIGKILL after `grace`: the executor's own release waits for exit without a bound.
export const stop = (proc: CommandExecutor.Process, grace: Duration.DurationInput = "5 seconds") =>
  proc.kill("SIGTERM").pipe(
    Effect.timeout(grace),
    Effect.catchAll(() => proc.kill("SIGKILL")),
    Effect.ignore,
  )

/** Starts `command`; the scope stops it on close. */
export const startScoped = (command: Command.Command) =>
  Effect.tap(Command.start(command), (proc) => Effect.addFinalizer(() => stop(proc)))

// stdout and stderr drain for the whole life of the process, so a chatty server never stalls.
export const collectOutput = (proc: CommandExecutor.Process) =>
  Effect.gen(function* () {
    const output = yield* Ref.make("")
    yield* Stream.merge(proc.stdout, proc.stderr).pipe(
      Stream.decodeText(),
      Stream.runForEach((text) => Ref.update(output, (all) => all + text)),
      Effect.forkScoped,
    )
    return output
  })

// Listening means /openapi.json answers: 401 counts, the spec sits behind authentication.
const answering = (base: string) =>
  send(base, "/openapi.json").pipe(
    Effect.timeout("2 seconds"),
    Effect.filterOrFail(({ status }) => status === 200 || status === 401),
    Effect.retry(Schedule.spaced("250 millis")),
    // The schedule never ends; only the caller's timeout or the process exit stops the wait.
    Effect.orDie,
    Effect.asVoid,
  )

const failWith = (output: Ref.Ref<string>, exit: number | null) =>
  Effect.flatMap(Ref.get(output), (text) => Effect.fail(new ServerDidNotStart({ output: text, exit })))

const exited = (proc: CommandExecutor.Process) =>
  proc.exitCode.pipe(
    Effect.map((code): number | null => code),
    Effect.orElseSucceed(() => null),
  )

/**
 * Waits until the server at `base` answers, or fails with its output when it exits first or stays
 * silent for `within`. Needs the real clock: the retry sleeps on it.
 */
export const waitReady = (
  base: string,
  proc: CommandExecutor.Process,
  output: Ref.Ref<string>,
  within: Duration.DurationInput = "30 seconds",
) =>
  Effect.raceFirst(
    answering(base),
    Effect.flatMap(exited(proc), (exit) => failWith(output, exit)),
  ).pipe(
    Effect.timeout(within),
    Effect.catchTag("TimeoutException", () => failWith(output, null)),
  )
