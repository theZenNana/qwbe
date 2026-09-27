import * as OpenApi from "@effect/platform/OpenApi"
import * as NodeContext from "@effect/platform-node/NodeContext"
import { expect, layer } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { EXPECTED_OPERATIONS, isReviewed, publishedSignatures, unguardedSignatures } from "./api-operations.ts"
import { mountCubes } from "./temp-env.ts"

class Paths extends Context.Tag("checks/unit/Paths")<Paths, OpenApi.OpenAPISpecPaths>() {}

// Built the way main.ts builds it, without the boot (decision 8).
const published = Effect.gen(function* () {
  const system = yield* mountCubes((definitions) => definitions.filter((d) => isReviewed(d.plugin)))
  const { buildApi } = yield* Effect.promise(() => import("../../src/runtime-composition.ts"))
  return OpenApi.fromApi(buildApi(system.cubes)).paths
})

layer(Layer.scoped(Paths, published).pipe(Layer.provide(NodeContext.layer)), {
  timeout: 60_000,
  excludeTestServices: true,
})((it) => {
  it.effect("publishes exactly the reviewed operations", () =>
    Effect.map(Paths, (paths) => expect(publishedSignatures(paths)).toEqual(EXPECTED_OPERATIONS)),
  )

  it.effect("declares bearer auth and a 401 on every operation except login", () =>
    Effect.map(Paths, (paths) => expect(unguardedSignatures(paths)).toEqual([])),
  )
})
