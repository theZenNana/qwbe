// Dev ports on disk and on the network: read from qwbe.yaml with the env overrides, and each checked
// free before anything starts (one line instead of an EADDRINUSE stack from inside Next).
import { createServer } from "node:net"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Either from "effect/Either"
import { ConfigInvalid, readConfig } from "./config.ts"
import { devPorts, portTakenMessage } from "./dev-pure.ts"

export class PortTaken extends Data.TaggedError("PortTaken")<{ readonly message: string }> {}

export const readDevPorts = (file: string, apiOverride: string | undefined, webOverride: string | undefined) =>
  Effect.flatMap(readConfig(file), ({ dev }) =>
    Either.mapLeft(devPorts(dev.api, dev.web, apiOverride, webOverride), (invalid) => new ConfigInvalid(invalid)),
  )

const isFree = (port: number) =>
  Effect.async<boolean>((resume) => {
    const probe = createServer()
    probe.once("error", () => resume(Effect.succeed(false)))
    probe.once("listening", () => probe.close(() => resume(Effect.succeed(true))))
    probe.listen(port, "127.0.0.1")
  })

export const ensureFree = (name: string, port: number) =>
  isFree(port).pipe(
    Effect.filterOrFail(
      (free) => free,
      () => new PortTaken({ message: portTakenMessage(name, port) }),
    ),
    Effect.asVoid,
  )
