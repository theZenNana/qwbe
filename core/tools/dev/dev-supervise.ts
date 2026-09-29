// The dev supervisor: each child's output echoed with a prefix, the API restarted on a clean exit,
// and the first child to stop ending the rest. Closing the scope (Ctrl-C) SIGTERMs each child's
// process group, so the Next grandchild under npm goes too.
import * as Command from "@effect/platform/Command"
import type * as CommandExecutor from "@effect/platform/CommandExecutor"
import type { PlatformError } from "@effect/platform/Error"
import * as Console from "effect/Console"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { ensureFree } from "./dev-ports.ts"
import { afterExit, banner, heapMessage, type Ports, prefixer, type ServiceName, type ServiceSpec } from "./dev-pure.ts"

type Prefix = (line: string) => string

const commandFor = (spec: ServiceSpec) =>
  Command.make(...spec.argv).pipe(
    Command.workingDirectory(spec.cwd),
    Command.env(spec.env, { extendEnv: false }),
    Command.runInShell(spec.shell),
  )

const echo = (prefix: Prefix, output: Stream.Stream<Uint8Array, PlatformError>) =>
  output.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => Console.log(prefix(line))),
  )

// The pid, and where SIGUSR2 writes the heap snapshot, for a service that has one.
const announce = (prefix: Prefix, heapDir: string | undefined, pid: number) =>
  heapDir === undefined ? Effect.void : Console.log(prefix(heapMessage(heapDir, pid)))

const echoUntilExit = (prefix: Prefix, child: CommandExecutor.Process) =>
  Effect.all([child.exitCode, echo(prefix, child.stdout), echo(prefix, child.stderr)], { concurrency: "unbounded" })

// One run with its output echoed; 1 when it could not start or a signal ended it.
const runOnce = (command: Command.Command, prefix: Prefix, heapDir: string | undefined) =>
  Effect.scoped(
    Effect.flatMap(Command.start(command), (child) =>
      Effect.zipRight(announce(prefix, heapDir, child.pid), echoUntilExit(prefix, child)),
    ),
  ).pipe(
    Effect.map(([code]) => code),
    Effect.catchAll((error) => Effect.as(Console.log(prefix(error.message)), 1)),
  )

// Repeats `run` until afterExit says stop; the result is the status the run ends with.
const supervise = (
  run: Effect.Effect<number, never, CommandExecutor.CommandExecutor>,
  prefix: Prefix,
  restartOnClean: boolean,
  quickExits = 0,
): Effect.Effect<number, never, CommandExecutor.CommandExecutor> =>
  Effect.flatMap(Effect.timed(run), ([ran, code]) => {
    const next = afterExit(restartOnClean, code, Duration.toMillis(ran), quickExits)
    const said = Console.log(prefix(next.message))
    return next._tag === "restart"
      ? said.pipe(
          Effect.zipRight(Effect.sleep(next.delayMillis)),
          Effect.zipRight(supervise(run, prefix, restartOnClean, next.quickExits)),
        )
      : Effect.as(said, next.status)
  })

const superviseService = (name: ServiceName, spec: ServiceSpec, tty: boolean) => {
  const prefix = prefixer(name, spec.color, tty)
  return supervise(runOnce(commandFor(spec), prefix, spec.heapDir), prefix, spec.restartOnClean)
}

// The first child to stop ends the race; the others are interrupted and their scopes close.
export const startServices = (
  names: ReadonlyArray<ServiceName>,
  ports: Ports,
  specs: Readonly<Record<ServiceName, ServiceSpec>>,
  tty: boolean,
) =>
  Effect.forEach(names, (name) => ensureFree(name, ports[name]), { discard: true }).pipe(
    Effect.zipRight(Console.log(banner(names, ports))),
    Effect.zipRight(Effect.raceAll(names.map((name) => superviseService(name, specs[name], tty)))),
  )
