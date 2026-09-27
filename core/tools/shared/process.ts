import * as Command from "@effect/platform/Command"
import type * as CommandExecutor from "@effect/platform/CommandExecutor"
import type { PlatformError } from "@effect/platform/Error"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { lines, withoutAllowScripts } from "./process-pure.ts"

export class GateFailed extends Data.TaggedError("GateFailed")<{
  readonly message: string
  readonly status: number
}> {}

export type Argv = readonly [string, ...string[]]

// A POSIX exit status is one byte; the executor's number is decoded, never trusted.
const ExitStatus = Schema.Int.pipe(Schema.between(0, 255))

const text = (stream: Stream.Stream<Uint8Array, PlatformError>) => stream.pipe(Stream.decodeText(), Stream.mkString)

type Env = Readonly<Record<string, string | undefined>>

// stdin is an empty stream, so the child reads end-of-file at once. The executor's default is a
// pipe nobody writes or closes, and a child (or a grandchild inheriting it) that reads stdin
// waits on it forever.
const commandFor = (argv: Argv, cwd: string, env: Env = {}) =>
  Command.make(...argv).pipe(
    Command.workingDirectory(cwd),
    Command.env({ ...withoutAllowScripts(process.env), ...env }),
    Command.stdin(Stream.empty),
  )

// stdout and stderr drain together, so a child that fills one pipe never stalls on it.
const drain = (child: CommandExecutor.Process) =>
  Effect.all(
    {
      status: Effect.flatMap(child.exitCode, Schema.decodeUnknown(ExitStatus)),
      stdout: text(child.stdout),
      stderr: text(child.stderr),
    },
    { concurrency: "unbounded" },
  )

export const capture = (argv: Argv, cwd: string) =>
  Effect.scoped(Effect.flatMap(Command.start(commandFor(argv, cwd)), drain))

// The child writes straight to this terminal; only its exit status comes back.
export const inherit = (argv: Argv, cwd: string, env: Env = {}) =>
  commandFor(argv, cwd, env).pipe(
    Command.stdout("inherit"),
    Command.stderr("inherit"),
    Command.exitCode,
    Effect.flatMap(Schema.decodeUnknown(ExitStatus)),
  )

// Like inherit, but a nonzero exit is a GateFailed carrying that status.
export const inheritOk = (argv: Argv, cwd: string, env: Env = {}) =>
  inherit(argv, cwd, env).pipe(
    Effect.filterOrFail(
      (status) => status === 0,
      (status) => new GateFailed({ message: `${argv.join(" ")} exited ${status} in ${cwd}`, status }),
    ),
  )

export const captureLines = (argv: Argv, cwd: string) =>
  capture(argv, cwd).pipe(
    Effect.filterOrFail(
      ({ status }) => status === 0,
      ({ status, stderr }) => new GateFailed({ message: `${argv.join(" ")}: ${stderr}`, status }),
    ),
    Effect.map(({ stdout }) => lines(stdout)),
  )
