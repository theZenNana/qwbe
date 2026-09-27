// Entry point: `node core/tools/dev/dev.ts [start|api|web]`, start (default) runs both. Every line is
// prefixed with who said it. Exit 0 of the API restarts it (the admin restart); any other exit
// stops the rest.
import { fileURLToPath } from "node:url"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { GateFailed } from "../shared/process.ts"
import { runTool } from "../shared/run-tool.ts"
import { readDevPorts } from "./dev-ports.ts"
import { SERVICES, serviceSpecs } from "./dev-pure.ts"
import { startServices } from "./dev-supervise.ts"

const Subcommand = Schema.Literal("start", "api", "web")

const root = fileURLToPath(new URL("../../..", import.meta.url))
const usage = new GateFailed({ message: "usage: node core/tools/dev/dev.ts [start|api|web]", status: 2 })

const subcommand = Effect.mapError(Schema.decodeUnknown(Subcommand)(process.argv[2] ?? "start"), () => usage)
const ports = readDevPorts(`${root}qwbe.yaml`, process.env.QWBE_PORT, process.env.QWBE_WEB_PORT)

runTool(
  Effect.flatMap(Effect.all([subcommand, ports]), ([name, ports]) =>
    startServices(
      SERVICES[name],
      ports,
      serviceSpecs(root, ports, process.env, process.execPath, process.platform === "win32"),
      process.stdout.isTTY === true,
    ),
  ),
)
