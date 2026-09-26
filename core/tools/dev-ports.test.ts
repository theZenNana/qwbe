import { createServer } from "node:net"
import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { devPorts, ensureFree } from "./dev-ports.ts"

const dev = { api: 4500, web: 4510 }

it("takes the qwbe.yaml ports when the environment says nothing", () => {
  expect(devPorts(dev, {})).toEqual(dev)
})

it("lets QWBE_PORT and QWBE_WEB_PORT move one port each", () => {
  expect(devPorts(dev, { QWBE_PORT: "4530" })).toEqual({ api: 4530, web: 4510 })
  expect(devPorts(dev, { QWBE_WEB_PORT: "4540" })).toEqual({ api: 4500, web: 4540 })
})

it.scoped("names a taken port and refuses a value that is not a port", () =>
  Effect.gen(function* () {
    const server = createServer()
    yield* Effect.acquireRelease(
      Effect.async<void>((resume) => void server.listen(0, "127.0.0.1", () => resume(Effect.void))),
      () => Effect.sync(() => server.close()),
    )
    const address = server.address()
    const port = typeof address === "object" && address !== null ? address.port : 0
    const taken = yield* Effect.flip(ensureFree("API", port))
    expect(taken.message).toContain(`Port ${port} (API) is already taken`)
    const bad = yield* Effect.flip(ensureFree("web", Number("abc")))
    expect(bad.message).toContain("is not a port")
  }),
)
