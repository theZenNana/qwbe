import { createServer } from "node:net"
import * as Effect from "effect/Effect"

// ponytail: close-then-reuse leaves a short race for the port; a server that takes port 0 and
// reports it back closes that race, but main.ts reads QWBE_PORT and cannot report one today.
/** A TCP port the OS reports free on 127.0.0.1 right now. */
export const freePort = Effect.async<number>((resume) => {
  const server = createServer()
  server.on("error", (error) => resume(Effect.die(error)))
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    server.close(() => resume(Effect.succeed(port)))
  })
})
