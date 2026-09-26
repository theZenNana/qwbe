import * as OpenApi from "@effect/platform/OpenApi"
import * as NodeContext from "@effect/platform-node/NodeContext"
import { expect, layer } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { EXPECTED_OPERATIONS } from "./api-operations.ts"
import { tempDirectoryAs } from "./temp-env.ts"

type Operation = OpenApi.OpenAPISpecOperation
type Published = readonly [method: string, path: string, operation: Operation]

class Spec extends Context.Tag("checks/unit/Spec")<Spec, ReadonlyArray<Published>>() {}

const METHODS: ReadonlyArray<string> = ["get", "post", "put", "patch", "delete"]

const parameterList = (parameters: ReadonlyArray<OpenApi.OpenAPISpecParameter>): string =>
  parameters
    .map((p) => `${p.in}:${p.name}${p.required ? "!" : ""}`)
    .sort()
    .join(",") || "-"

const statusList = (statuses: ReadonlyArray<string>): string =>
  [...statuses].sort((a, b) => Number(a) - Number(b)).join(",")

/** One line in the format of api-operations.ts. */
const signature = ([method, path, operation]: Published): string =>
  [
    `${method.toUpperCase()} ${path}`,
    parameterList(operation.parameters),
    operation.requestBody ? "body" : "-",
    statusList(Object.keys(operation.responses)),
  ].join("|")

const operationsOf = (paths: OpenApi.OpenAPISpecPaths): ReadonlyArray<Published> =>
  Object.entries(paths).flatMap(([path, item]) =>
    Object.entries(item).flatMap(([method, operation]) =>
      METHODS.includes(method) ? [[method, path, operation]] : [],
    ),
  )

const isLogin = ([method, path]: Published): boolean => method === "post" && path === "/auth/login"

const declaresBearer401 = ([, , operation]: Published): boolean =>
  "401" in operation.responses && operation.security.some((requirement) => "bearer" in requirement)

// Core cubes plus the committed example-plugin; a package installed locally extends the API at
// runtime and answers for its own routes.
const isReviewed = (plugin: string | null): boolean => plugin === null || plugin === "example-plugin"

// Built the way main.ts builds it, without the boot: no database, no port (decision 8). mount
// may write switches.json, so the data directory is a scoped temp directory.
const published = Effect.gen(function* () {
  yield* tempDirectoryAs("QWBE_DATA_DIR")
  const { loadDefinitions, mount } = yield* Effect.promise(() => import("../../src/kernel/discovery.ts"))
  const { loadSpaces } = yield* Effect.promise(() => import("../../src/kernel/space.ts"))
  const { buildApi } = yield* Effect.promise(() => import("../../src/runtime-composition.ts"))
  const definitions = (yield* Effect.promise(loadDefinitions)).filter((d) => isReviewed(d.plugin))
  const system = mount(definitions, yield* Effect.promise(loadSpaces))
  return operationsOf(OpenApi.fromApi(buildApi(system.cubes)).paths)
})

layer(Layer.scoped(Spec, published).pipe(Layer.provide(NodeContext.layer)), {
  timeout: 60_000,
  excludeTestServices: true,
})((it) => {
  it.effect("publishes exactly the reviewed operations", () =>
    Effect.map(Spec, (operations) => expect(operations.map(signature).sort()).toEqual(EXPECTED_OPERATIONS)),
  )

  it.effect("declares bearer auth and a 401 on every operation except login", () =>
    Effect.map(Spec, (operations) =>
      expect(operations.filter((o) => !isLogin(o) && !declaresBearer401(o)).map(signature)).toEqual([]),
    ),
  )
})
