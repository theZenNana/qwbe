// Entry point: `node core/tools/dev.ts [start|api|web]`, start (default) runs both. Every line is
// prefixed with who said it. Exit 0 of the API restarts it (the admin restart); any other exit
// stops the rest. Closing the scope (Ctrl-C) SIGTERMs each child's process group, so the Next
// grandchild under npm goes too.
import { fileURLToPath } from "node:url"
import * as Command from "@effect/platform/Command"
import type { CommandExecutor } from "@effect/platform/CommandExecutor"
import type { PlatformError } from "@effect/platform/Error"
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Console from "effect/Console"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { ensureFree, readDevPorts } from "./dev-ports.ts"
import {
  afterExit,
  banner,
  type Ports,
  prefixer,
  SERVICES,
  type ServiceName,
  type ServiceSpec,
  serviceSpecs,
} from "./dev-pure.ts"
import { GateFailed } from "./process.ts"

type Prefix = (line: string) => string

const Subcommand = Schema.Literal("start", "api", "web")

const commandFor = (spec: ServiceSpec) =>
  Command.make(...spec.argv).pipe(
    Command.workingDirectory(spec.cwd),
    Command.env(spec.env),
    Command.runInShell(spec.shell),
  )

const echo = (prefix: Prefix, output: Stream.Stream<Uint8Array, PlatformError>) =>
  output.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => Console.log(prefix(line))),
  )

// One run with its output echoed; 1 when it could not start or a signal ended it.
const runOnce = (command: Command.Command, prefix: Prefix) =>
  Effect.scoped(
    Effect.flatMap(Command.start(command), (child) =>
      Effect.all([child.exitCode, echo(prefix, child.stdout), echo(prefix, child.stderr)], {
        concurrency: "unbounded",
      }),
    ),
  ).pipe(
    Effect.map(([code]) => code),
    Effect.catchAll((error) => Effect.as(Console.log(prefix(error.message)), 1)),
  )

// Runs the command until afterExit says stop; the result is the status the run ends with.
const supervise = (
  command: Command.Command,
  prefix: Prefix,
  restartOnClean: boolean,
  quickExits = 0,
): Effect.Effect<number, never, CommandExecutor> =>
  Effect.flatMap(Effect.timed(runOnce(command, prefix)), ([ran, code]) => {
    const next = afterExit(restartOnClean, code, Duration.toMillis(ran), quickExits)
    const said = Console.log(prefix(next.message))
    return next._tag === "restart"
      ? said.pipe(
          Effect.zipRight(Effect.sleep(next.delayMillis)),
          Effect.zipRight(supervise(command, prefix, restartOnClean, next.quickExits)),
        )
      : Effect.as(said, next.status)
  })

const superviseService = (name: ServiceName, spec: ServiceSpec, tty: boolean) =>
  supervise(commandFor(spec), prefixer(name, spec.color, tty), spec.restartOnClean)

// The first child to stop ends the race; the others are interrupted and their scopes close.
const startServices = (
  names: ReadonlyArray<ServiceName>,
  ports: Ports,
  specs: Readonly<Record<ServiceName, ServiceSpec>>,
  tty: boolean,
) =>
  Effect.forEach(names, (name) => ensureFree(name, ports[name]), { discard: true }).pipe(
    Effect.zipRight(Console.log(banner(names, ports))),
    Effect.zipRight(Effect.raceAll(names.map((name) => superviseService(name, specs[name], tty)))),
  )

const root = fileURLToPath(new URL("../..", import.meta.url))
const usage = new GateFailed({ message: "usage: node core/tools/dev.ts [start|api|web]", status: 2 })

Effect.all([
  Effect.mapError(Schema.decodeUnknown(Subcommand)(process.argv[2] ?? "start"), () => usage),
  readDevPorts(`${root}qwbe.yaml`, process.env.QWBE_PORT, process.env.QWBE_WEB_PORT),
]).pipe(
  Effect.flatMap(([subcommand, ports]) =>
    startServices(
      SERVICES[subcommand],
      ports,
      serviceSpecs(root, ports, process.env, process.execPath, process.platform === "win32"),
      process.stdout.isTTY === true,
    ),
  ),
  Effect.catchAll((error) => Effect.as(Console.error(error.message), 1)),
  Effect.tap((code) => Effect.sync(() => (process.exitCode = code))),
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain,
)
