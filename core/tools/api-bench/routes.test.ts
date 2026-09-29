import { expect, it } from "@effect/vitest"
import { coverage, fixturedRoutes, numbered, routesOf, urlOf } from "./routes.ts"

const spec = {
  paths: {
    "/notes": { get: { tags: ["notes"] }, post: { tags: ["notes"] } },
    "/notes/{id}": { delete: { tags: ["notes"] } },
  },
}

const config = {
  report: "r.json",
  rows: 10,
  requests: { warmup: 1, c1: 1, c20: 1 },
  seeds: [{ table: "notes.notes", create: "POST /notes" }],
  budgets: { default: { c1: 10, c20: 50 }, routes: {} },
  exclude: { "DELETE /notes/{id}": "deletes its target" },
  routes: { "GET /notes": {}, "POST /notes": { body: { title: "t{n}" } } },
}

it("reads every operation of the spec as METHOD /path with its tag as cube", () => {
  expect(routesOf(spec).map(({ key, cube }) => `${key} ${cube}`)).toEqual([
    "GET /notes notes",
    "POST /notes notes",
    "DELETE /notes/{id} notes",
  ])
})

it("pairs each route with its fixture and leaves the excluded ones out", () => {
  expect(fixturedRoutes(routesOf(spec), config.routes).map(({ route, fixture }) => [route.key, fixture])).toEqual([
    ["GET /notes", {}],
    ["POST /notes", { body: { title: "t{n}" } }],
  ])
})

it("full coverage has no findings", () => {
  expect(coverage(routesOf(spec), config)).toEqual([])
})

it("a route with neither fixture nor exclusion, and a key naming no route, are findings", () => {
  const routes = { "GET /notes": {}, "GET /gone": {} }
  expect(coverage(routesOf(spec), { ...config, routes, seeds: [] })).toEqual([
    "POST /notes: no fixture in apiBench.routes and not in apiBench.exclude",
    "GET /gone: in qwbe.yaml apiBench but not in the OpenAPI spec",
  ])
})

it("a seed whose create route has no fixture is a finding", () => {
  expect(coverage(routesOf(spec), { ...config, seeds: [{ table: "t.t", create: "PUT /x" }] })).toEqual([
    'seed t.t: create "PUT /x" has no fixture in apiBench.routes',
  ])
})

it("a fixture that leaves a path param unset is a finding", () => {
  const routes = { ...config.routes, "DELETE /notes/{id}": {} }
  expect(coverage(routesOf(spec), { ...config, routes, exclude: {} })).toEqual([
    'DELETE /notes/{id}: fixture has no path param "id"',
  ])
})

it("fills path params (encoded) and the query string", () => {
  expect(urlOf("/links/{entity}/{id}", { params: { entity: "Note", id: "a b" }, query: { page: 2, q: "x" } })).toBe(
    "/links/Note/a%20b?page=2&q=x",
  )
  expect(urlOf("/notes", {})).toBe("/notes")
})

it("numbers every {n} in params, query and body, and fills {root}", () => {
  expect(
    numbered(
      { params: { id: "view-bench{n}" }, query: { q: "{n}" }, body: { names: ["u{n}"], path: "{root}/x" } },
      7,
      "/r",
    ),
  ).toEqual({
    params: { id: "view-bench7" },
    query: { q: "7" },
    body: { names: ["u7"], path: "/r/x" },
  })
})
