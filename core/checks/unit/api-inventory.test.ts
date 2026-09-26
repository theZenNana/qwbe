import * as FileSystem from "@effect/platform/FileSystem"
import * as OpenApi from "@effect/platform/OpenApi"
import * as NodeContext from "@effect/platform-node/NodeContext"
import { expect, layer } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { EXPECTED_OPERATIONS } from "./api-operations.ts"

interface Operation {
  readonly parameters?: ReadonlyArray<{ readonly in: string; readonly name: string; readonly required?: boolean }>
  readonly requestBody?: unknown
  readonly responses?: Readonly<Record<string, unknown>>
  readonly security?: ReadonlyArray<Readonly<Record<string, unknown>>>
}
interface Published {
  readonly method: string
  readonly path: string
  readonly operation: Operation
}

class Spec extends Context.Tag("Spec")<Spec, ReadonlyArray<Published>>() {}

const METHODS = ["get", "post", "put", "patch", "delete"]

/** "METHOD /path|parameters|body|statuses", the line format of api-operations.ts. */
const signature = ({ method, path, operation }: Published): string => {
  const parameters = (operation.parameters ?? []).map((p) => `${p.in}:${p.name}${p.required ? "!" : ""}`).sort()
  const statuses = Object.keys(operation.responses ?? {}).sort((a, b) => Number(a) - Number(b))
  return `${method.toUpperCase()} ${path}|${parameters.join(",") || "-"}|${operation.requestBody ? "body" : "-"}|${statuses.join(",")}`
}

const operationsOf = (paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>): ReadonlyArray<Published> =>
  Object.entries(paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => METHODS.includes(method))
      .map(([method, operation]) => ({ method, path, operation: operation as Operation })),
  )

// Core cubes plus the committed example-plugin; a package installed locally extends the API
// at runtime and is checked by its own probe, not by this list.
const isReviewed = (definition: { readonly plugin: string | null }) =>
  definition.plugin === null || definition.plugin === "example-plugin"

// The kernel reads QWBE_DATA_DIR at import and mount may write switches.json, so the data
// directory is a scoped temp directory set before the first kernel import. No database, no port.
const published = Effect.gen(function* () {
  process.env.QWBE_DATA_DIR = yield* FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.makeTempDirectoryScoped()))
  const { loadDefinitions, mount } = yield* Effect.promise(() => import("../../src/kernel/discovery.ts"))
  const { loadSpaces } = yield* Effect.promise(() => import("../../src/kernel/space.ts"))
  const { buildApi } = yield* Effect.promise(() => import("../../src/runtime-composition.ts"))
  const definitions = (yield* Effect.promise(loadDefinitions)).filter(isReviewed)
  const system = mount(definitions, yield* Effect.promise(loadSpaces))
  return operationsOf(OpenApi.fromApi(buildApi(system.cubes)).paths as never)
})

layer(Layer.scoped(Spec, published).pipe(Layer.provide(NodeContext.layer)), {
  timeout: 60_000,
  excludeTestServices: true,
})((it) => {
  it.effect("publishes exactly the reviewed operations", () =>
    Effect.gen(function* () {
      expect((yield* Spec).map(signature).sort()).toEqual(EXPECTED_OPERATIONS)
    }),
  )

  it.effect("declares bearer auth and a 401 on every operation except login", () =>
    Effect.gen(function* () {
      const unguarded = (yield* Spec)
        .filter(({ method, path }) => !(method === "post" && path === "/auth/login"))
        .filter(({ operation }) => !operation.responses?.["401"] || !operation.security?.some((s) => "bearer" in s))
      expect(unguarded.map(signature)).toEqual([])
    }),
  )
})
