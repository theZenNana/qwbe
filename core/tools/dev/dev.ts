// Entry point: `node core/tools/dev/dev.ts [start|api|web] [--profile] [--cpu-prof]`, start (default)
// runs both. Every line is prefixed with who said it. Exit 0 of the API restarts it (the admin
// restart); any other exit stops the rest. --profile starts the local lgtm and traces the API into
// it; --cpu-prof writes a V8 CPU profile when the API stops; SIGUSR2 to the API writes a heap snapshot.
import { fileURLToPath } from "node:url"
import * as FileSystem from "@effect/platform/FileSystem"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { GateFailed, inheritOk } from "../shared/process.ts"
import { runTool } from "../shared/run-tool.ts"
import { readDevPorts } from "./dev-ports.ts"
import {
  cpuProfMessage,
  type DevArgs,
  devArgs,
  grafanaMessage,
  LGTM_UP,
  type Ports,
  PROFILE_DIRS,
  SERVICES,
  serviceSpecs,
} from "./dev-pure.ts"
import { startServices } from "./dev-supervise.ts"

const root = fileURLToPath(new URL("../../..", import.meta.url))
const usage = new GateFailed({
  message: "usage: node core/tools/dev/dev.ts [start|api|web] [--profile] [--cpu-prof]",
  status: 2,
})

const args = Effect.mapError(devArgs(process.argv.slice(2)), () => usage)
const override = (name: string) => Effect.map(Effect.orDie(Config.option(Config.string(name))), Option.getOrUndefined)
const ports = Effect.flatMap(Effect.all([override("QWBE_PORT"), override("QWBE_WEB_PORT")]), ([api, web]) =>
  readDevPorts(`${root}qwbe.yaml`, api, web),
)

// Node does not create the --diagnostic-dir; a snapshot into a missing one crashes the API.
const makeHeapDir = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  Effect.orDie(fs.makeDirectory(`${root}${PROFILE_DIRS.heap}`, { recursive: true })),
)
const startLgtm = Effect.zipRight(inheritOk(LGTM_UP, root), Console.log(grafanaMessage(process.env.QWBE_GRAFANA_PORT)))
const prepare = (profile: boolean) => Effect.all([makeHeapDir, profile ? startLgtm : Effect.void])

const runServices = (args: DevArgs, ports: Ports) =>
  startServices(
    SERVICES[args.name],
    ports,
    // The children get the whole environment on purpose; serviceSpecs strips only what npm adds.
    serviceSpecs(root, ports, process.env, process.execPath, process.platform === "win32", args),
    process.stdout.isTTY === true,
  )

const sayWhereCpuProfileIs = (cpuProf: boolean) => (cpuProf ? Console.log(cpuProfMessage(root)) : Effect.void)

runTool(
  Effect.flatMap(Effect.all([args, ports]), ([args, ports]) =>
    Effect.zipRight(
      prepare(args.profile),
      Effect.ensuring(runServices(args, ports), sayWhereCpuProfileIs(args.cpuProf)),
    ),
  ),
)
