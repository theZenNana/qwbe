import { createServer } from "node:net"
import * as Effect from "effect/Effect"

/** A TCP port the OS reports free on 127.0.0.1 right now. */
export const freePort = Effect.async<number>((resume) => {
  const server = createServer()
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    server.close(() => resume(Effect.succeed(port)))
  })
})
