// Entry point: `node core/tools/dev/dev.ts [start|api|web]`, start (default) runs both. Every line is
// prefixed with who said it. Exit 0 of the API restarts it (the admin restart); any other exit
// stops the rest.
import { fileURLToPath } from "node:url"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
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
const override = (name: string) => Effect.map(Effect.orDie(Config.option(Config.string(name))), Option.getOrUndefined)
const ports = Effect.flatMap(Effect.all([override("QWBE_PORT"), override("QWBE_WEB_PORT")]), ([api, web]) =>
  readDevPorts(`${root}qwbe.yaml`, api, web),
)

runTool(
  Effect.flatMap(Effect.all([subcommand, ports]), ([name, ports]) =>
    startServices(
      SERVICES[name],
      ports,
      // The children get the whole environment on purpose; serviceSpecs strips only what npm adds.
      serviceSpecs(root, ports, process.env, process.execPath, process.platform === "win32"),
      process.stdout.isTTY === true,
    ),
  ),
)
