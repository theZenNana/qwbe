// The route inventory of the API benchmark: the OpenAPI spec to routes, fixture coverage, and the
// URL and numbering of one request.
import * as Schema from "effect/Schema"
import { type ApiBench, Fixture } from "../shared/config.ts"

const METHODS = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE" } as const

export type Method = (typeof METHODS)[keyof typeof METHODS]

const Operation = Schema.optional(Schema.Struct({ tags: Schema.optional(Schema.Array(Schema.String)) }))

// Only what the bench reads; the rest of the spec (parameters, schemas...) is ignored, not refused.
export const OpenApi = Schema.Struct({
  paths: Schema.Record({
    key: Schema.String,
    value: Schema.Struct({ get: Operation, post: Operation, put: Operation, patch: Operation, delete: Operation }),
  }),
})

export interface Route {
  readonly key: string
  readonly method: Method
  readonly path: string
  readonly cube: string
}

/** Every operation of the spec as "METHOD /path", with its first tag as the cube. */
export const routesOf = (spec: typeof OpenApi.Type): ReadonlyArray<Route> =>
  Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.entries(METHODS).flatMap(([lower, method]) => {
      const operation = item[lower as keyof typeof METHODS]
      return operation === undefined
        ? []
        : [{ key: `${method} ${path}`, method, path, cube: operation.tags?.[0] ?? "?" }]
    }),
  )

const paramNames = (path: string) => [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "")

type Fixtures = typeof ApiBench.Type.routes

type Keyed = Readonly<Record<string, unknown>>

/** Each route with the fixture it is called with; a route without one (excluded) is left out. */
export const fixturedRoutes = (routes: ReadonlyArray<Route>, fixtures: Fixtures) =>
  routes.flatMap((route) => {
    const fixture = fixtures[route.key]
    return fixture === undefined ? [] : [{ route, fixture }]
  })

const unfixtured = (keys: ReadonlyArray<string>, fixtures: Keyed, exclude: Keyed) =>
  keys
    .filter((key) => fixtures[key] === undefined && exclude[key] === undefined)
    .map((key) => `${key}: no fixture in apiBench.routes and not in apiBench.exclude`)

const doubled = (keys: ReadonlyArray<string>, fixtures: Keyed, exclude: Keyed) =>
  keys
    .filter((key) => fixtures[key] !== undefined && exclude[key] !== undefined)
    .map((key) => `${key}: both a fixture and excluded`)

const unknownKeys = (keys: ReadonlyArray<string>, fixtures: Keyed, exclude: Keyed) => {
  const known = new Set(keys)
  return [...Object.keys(fixtures), ...Object.keys(exclude)]
    .filter((key) => !known.has(key))
    .map((key) => `${key}: in qwbe.yaml apiBench but not in the OpenAPI spec`)
}

const missingParams = ({ key, path }: Route, { params }: typeof Fixture.Type) =>
  paramNames(path)
    .filter((name) => params?.[name] === undefined)
    .map((name) => `${key}: fixture has no path param "${name}"`)

const unfixturedSeeds = (seeds: typeof ApiBench.Type.seeds, fixtures: Keyed) =>
  seeds
    .filter(({ create }) => create !== undefined && fixtures[create] === undefined)
    .map(({ table, create }) => `seed ${table}: create "${create}" has no fixture in apiBench.routes`)

/**
 * Every route without a fixture or an exclusion, every key naming no route, every path param left
 * unset, every seed whose `create` has no fixture.
 */
export const coverage = (
  routes: ReadonlyArray<Route>,
  { routes: fixtures, exclude, seeds }: Pick<typeof ApiBench.Type, "routes" | "exclude" | "seeds">,
) => {
  const keys = routes.map(({ key }) => key)
  return [
    ...unfixtured(keys, fixtures, exclude),
    ...doubled(keys, fixtures, exclude),
    ...unknownKeys(keys, fixtures, exclude),
    ...fixturedRoutes(routes, fixtures).flatMap(({ route, fixture }) => missingParams(route, fixture)),
    ...unfixturedSeeds(seeds, fixtures),
  ]
}

/** The path with its params filled in, plus the query string. */
export const urlOf = (path: string, fixture: Pick<typeof Fixture.Type, "params" | "query">) => {
  const filled = path.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(fixture.params?.[name] ?? ""))
  const query = new URLSearchParams(Object.entries(fixture.query ?? {}).map(([key, value]) => [key, String(value)]))
  return query.size === 0 ? filled : `${filled}?${query}`
}

/**
 * The fixture with every `{n}` in its params, query and body replaced by `n`: repeated creates stay
 * unique, and a delete takes a different seeded row each time (`view-bench{n}`). `{root}` becomes
 * the repo root, for a route that takes an absolute path.
 */
export const numbered = (fixture: typeof Fixture.Type, n: number, root: string): typeof Fixture.Type =>
  Schema.decodeUnknownSync(Fixture)(
    JSON.parse(JSON.stringify(fixture).replaceAll("{n}", String(n)).replaceAll("{root}", root)),
  )
