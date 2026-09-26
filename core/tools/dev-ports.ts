import { createServer } from "node:net"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import { loadConfig } from "./config.ts"

export class PortTaken extends Data.TaggedError("PortTaken")<{ readonly message: string }> {}

export interface DevPorts {
  readonly api: number
  readonly web: number
}

/** qwbe.yaml decides; QWBE_PORT and QWBE_WEB_PORT move one port for a single run. */
export const devPorts = (dev: DevPorts, env: Readonly<Record<string, string | undefined>>): DevPorts => ({
  api: env.QWBE_PORT === undefined ? dev.api : Number(env.QWBE_PORT),
  web: env.QWBE_WEB_PORT === undefined ? dev.web : Number(env.QWBE_WEB_PORT),
})

export const loadDevPorts = (file: string) =>
  loadConfig(file).pipe(Effect.map((config) => devPorts(config.dev, process.env)))

const isFree = (port: number) =>
  Effect.async<boolean>((resume) => {
    const probe = createServer()
    probe.once("error", () => resume(Effect.succeed(false)))
    probe.once("listening", () => probe.close(() => resume(Effect.succeed(true))))
    probe.listen(port, "127.0.0.1")
  })

/** One line naming the port instead of an EADDRINUSE stack from deep inside Next. */
export const ensureFree = (name: string, port: number) =>
  Number.isInteger(port) && port >= 1 && port <= 65535
    ? isFree(port).pipe(
        Effect.filterOrFail(
          (free) => free,
          () =>
            new PortTaken({
              message: `Port ${port} (${name}) is already taken, nothing was started. See who has it: ss -ltnp | grep ${port}`,
            }),
        ),
        Effect.asVoid,
      )
    : Effect.fail(new PortTaken({ message: `${name} port ${port} is not a port (1-65535)` }))
