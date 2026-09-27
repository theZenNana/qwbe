import { createServer } from "node:net"
import { fileURLToPath } from "node:url"
import * as NodeContext from "@effect/platform-node/NodeContext"
import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { ensureFree, readDevPorts } from "./dev-ports.ts"

const qwbeYaml = fileURLToPath(new URL("../../qwbe.yaml", import.meta.url))

const listening = Effect.acquireRelease(
  Effect.async<ReturnType<typeof createServer>>((resume) => {
    const server = createServer()
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)))
  }),
  (server) => Effect.sync(() => server.close()),
)

const portOf = (server: ReturnType<typeof createServer>) => {
  const address = server.address()
  return typeof address === "object" && address !== null ? address.port : 0
}

it.layer(NodeContext.layer)("readDevPorts", (it) => {
  it.effect("takes qwbe.yaml, an env override moves one port", () =>
    Effect.gen(function* () {
      expect(yield* readDevPorts(qwbeYaml, undefined, undefined)).toEqual({ api: 4500, web: 4510 })
      expect(yield* readDevPorts(qwbeYaml, "4530", undefined)).toEqual({ api: 4530, web: 4510 })
    }),
  )

  it.effect("refuses an override that is not a port", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(readDevPorts(qwbeYaml, undefined, "70000"))
      expect(error.message).toBe("QWBE_WEB_PORT=70000: not a port (1-65535)")
    }),
  )
})

it.scoped("ensureFree fails with one line naming a taken port", () =>
  Effect.gen(function* () {
    const port = portOf(yield* listening)
    const error = yield* Effect.flip(ensureFree("api", port))
    expect(error.message).toContain(`Port ${port} (api) is already taken, nothing was started.`)
  }),
)
