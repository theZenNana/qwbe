// The one TCP port probe: listen on 127.0.0.1 and close again. `qwbe check`, the check suites and
// the dev supervisor all ask the OS through it. `node:net` stays (audit section 4): Effect has no
// equivalent.

import { createServer } from "node:net"
import { Effect } from "effect"

/** Listens on `port` (0 = any free one) and returns the port the OS bound; fails when it is taken. */
const listenOnce = (port: number) =>
  Effect.async<number, Error>((resume) => {
    const server = createServer()
    server.once("error", (error) => resume(Effect.fail(error)))
    server.listen(port, "127.0.0.1", () => {
      const address = server.address()
      const bound = typeof address === "object" && address ? address.port : 0
      server.close(() => resume(Effect.succeed(bound)))
    })
  })

// ponytail: close-then-reuse leaves a short race for the port; a server that takes port 0 and
// reports it back closes that race, but main.ts reads QWBE_PORT and cannot report one today.
/** A TCP port the OS reports free on 127.0.0.1 right now. */
export const freePort = Effect.orDie(listenOnce(0))

/** Whether `port` on 127.0.0.1 is free right now. */
export const isPortFree = (port: number) =>
  listenOnce(port).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )
