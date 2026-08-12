// Contract-first gate: the live server must obey the Effect-generated OpenAPI document, and the
// checker must prove it can fail by rejecting deliberately mutated responses and declarations.

import { EXPECTED_OPERATIONS } from "./contract-inventory.mjs"
import {
  operationContractIsDeclared,
  operationSignature,
  responseConforms,
  responseSchema,
  validates,
} from "./contract-validator.mjs"
import { client, dropScratch, freePort, makeScore, scratchDataDir, startServer, stopServer } from "./lib.mjs"

const PORT = await freePort()
const dataDir = scratchDataDir("contract")
const score = makeScore()
const api = client(PORT)
const server = await startServer(PORT, { QWBE_DATA_DIR: dataDir })

if (!server.alive) {
  dropScratch(dataDir)
  console.error(`server did not start:\n${server.output}`)
  process.exit(1)
}

try {
  const openapi = await api.call("/openapi.json")
  const spec = openapi.body
  score.check("OpenAPI is served as 3.1 JSON", openapi.status === 200 && spec?.openapi === "3.1.0")

  // The inventory below guards the kernel's own API -- core cubes plus the committed
  // example-plugin fixture. Cubes mounted from an INSTALLED package (QWB-28/29) extend the
  // surface at runtime; their contract is the package's own probe, not this inventory. Their
  // routes are filtered out by cube prefix so the gate stays green both ways.
  const sessionForFilter = await api.login()
  const catalogue = await api.call("/settings/cubes", { headers: sessionForFilter.headers })
  const installedCubePrefixes = new Set(
    (catalogue.body ?? [])
      .filter((c) => c.plugin && c.plugin !== "example-plugin")
      .flatMap((c) => [`/${c.name}`, `/${c.name}/`]),
  )
  const isInstalledCubeRoute = (path) =>
    [...installedCubePrefixes].some(
      (prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`),
    )

  const operations = Object.entries(spec?.paths ?? {})
    .filter(([path]) => !isInstalledCubeRoute(path))
    .flatMap(([path, methods]) =>
      Object.entries(methods)
        .filter(([method]) => ["get", "post", "put", "patch", "delete"].includes(method))
        .map(([method, operation]) => ({ path, method, operation })),
    )
  const actualInventory = operations
    .map(({ path, method, operation }) => operationSignature(path, method, operation))
    .sort()
  score.check(
    "route, parameter, payload and response-status inventory matches",
    JSON.stringify(actualInventory) === JSON.stringify(EXPECTED_OPERATIONS),
  )
  score.check(
    "every parameter, payload and declared response/error has a resolvable schema",
    operations.every(({ path, operation }) => operationContractIsDeclared(spec, path, operation)),
  )

  const protectedOperations = operations.filter((x) => !(x.path === "/auth/login" && x.method === "post"))
  const authDeclared = protectedOperations.every(
    ({ operation }) => operation.responses?.["401"] && operation.security?.some((entry) => entry.bearer),
  )
  score.check("every operation except login declares bearer auth and 401", authDeclared)

  // Authentication runs before payload and path decoding. Thus every declared protected route,
  // including mutations, can safely be called anonymously with inert placeholder input.
  const anonymousResults = await Promise.all(
    protectedOperations.map(async ({ path, method }) => {
      const concrete = path.replaceAll(/\{[^}]+\}/g, "contract-probe-missing")
      const result = await api.call(concrete, {
        method: method.toUpperCase(),
        headers: { "content-type": "application/json" },
        body: ["get", "delete"].includes(method) ? undefined : "{}",
      })
      return { path, method, result }
    }),
  )
  const anonymousOk = anonymousResults.every(
    ({ path, method, result }) => result.status === 401 && responseConforms(spec, path, method, 401, result.body),
  )
  const badAnonymous = anonymousResults.find(
    ({ path, method, result }) => result.status !== 401 || !responseConforms(spec, path, method, 401, result.body),
  )
  score.check(
    "every protected route rejects anonymous requests with its declared 401 body",
    anonymousOk,
    badAnonymous ? `${badAnonymous.method.toUpperCase()} ${badAnonymous.path}: http=${badAnonymous.result.status}` : "",
  )

  const session = await api.login()
  // The shared login helper intentionally returns only the token and headers. Read the complete
  // response once as contract evidence rather than fabricating the omitted fields.
  const login = await api.call("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin" }),
  })
  score.check(
    "login response matches declared status and schema",
    responseConforms(spec, "/auth/login", "post", login.status, login.body),
  )

  const samples = [
    ["/auth/me", "get"],
    ["/settings/cubes", "get"],
    ["/notes", "get"],
    ["/bookmarks", "get"],
    ["/tags", "get"],
    ["/booktags-settings", "get"],
  ]
  for (const [path, method] of samples) {
    const result = await api.call(path, { headers: session.headers })
    score.check(
      `${method.toUpperCase()} ${path} matches declared success`,
      responseConforms(spec, path, method, result.status, result.body),
    )
  }

  const schema = responseSchema(spec, "/settings/cubes", "get", 200)
  const cubes = (await api.call("/settings/cubes", { headers: session.headers })).body
  const mutatedBody = Array.isArray(cubes)
    ? cubes.map((cube, index) => (index === 0 ? { ...cube, enabled: "yes" } : cube))
    : cubes
  score.check("mutation sentinel rejects a wrong response field type", !validates(spec, schema, mutatedBody))

  const mutatedSpec = structuredClone(spec)
  delete mutatedSpec.paths["/auth/me"].get.responses["401"]
  score.check(
    "mutation sentinel rejects a removed declared auth status",
    !responseConforms(
      mutatedSpec,
      "/auth/me",
      "get",
      401,
      anonymousResults.find((x) => x.path === "/auth/me")?.result.body,
    ),
  )

  const parameterMutation = structuredClone(spec.paths["/account/{id}"].get)
  parameterMutation.parameters = []
  score.check(
    "mutation sentinel rejects path-parameter drift",
    !operationContractIsDeclared(spec, "/account/{id}", parameterMutation) &&
      !EXPECTED_OPERATIONS.includes(operationSignature("/account/{id}", "get", parameterMutation)),
  )

  const errorMutation = structuredClone(spec.paths["/account/{id}"].get)
  delete errorMutation.responses["404"]
  score.check(
    "mutation sentinel rejects non-401 error-status drift",
    !EXPECTED_OPERATIONS.includes(operationSignature("/account/{id}", "get", errorMutation)),
  )
} finally {
  await stopServer(server)
  dropScratch(dataDir)
}

process.exit(score.report("Contract-first probe"))
