// Dev ports on disk and on the network: read from qwbe.yaml with the env overrides, and each checked
// free before anything starts (one line instead of an EADDRINUSE stack from inside Next).
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Either from "effect/Either"
import { isPortFree } from "../../src/free-port.ts"
import { ConfigInvalid, readConfig } from "../shared/config.ts"
import { devPorts, portTakenMessage } from "./dev-pure.ts"

export class PortTaken extends Data.TaggedError("PortTaken")<{ readonly message: string }> {}

export const readDevPorts = (file: string, apiOverride: string | undefined, webOverride: string | undefined) =>
  Effect.flatMap(readConfig(file), ({ dev }) =>
    Either.mapLeft(devPorts(dev.api, dev.web, apiOverride, webOverride), (invalid) => new ConfigInvalid(invalid)),
  )

export const ensureFree = (name: string, port: number) =>
  isPortFree(port).pipe(
    Effect.filterOrFail(
      (free) => free,
      () => new PortTaken({ message: portTakenMessage(name, port) }),
    ),
    Effect.asVoid,
  )
