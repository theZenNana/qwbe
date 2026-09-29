import { expect, it } from "@effect/vitest"
import {
  budgetFindings,
  byP99,
  errorFindings,
  percentile,
  type Result,
  type Stats,
  statsOf,
  TIMEOUT,
  verdict,
} from "./stats.ts"

const stats = (p99: number, errors = 0, timeouts = 0): Stats => ({
  p50: 1,
  p99,
  max: p99,
  rps: 100,
  errors,
  statuses: errors ? [500] : [],
  timeouts,
})
const result = (key: string, c1: number, c20: number): Result => ({
  key,
  cube: "notes",
  c1: stats(c1),
  c20: stats(c20),
})

it("nearest-rank percentiles", () => {
  const sorted = Array.from({ length: 100 }, (_, i) => i + 1)
  expect([percentile(sorted, 50), percentile(sorted, 99), percentile([7], 99), percentile([], 50)]).toEqual([
    50, 99, 7, 0,
  ])
})

it("stats count non-2xx answers and requests per second over the wall time", () => {
  const samples = [
    { ms: 3, status: 200 },
    { ms: 1, status: 204 },
    { ms: 9, status: 500 },
    { ms: 2, status: 404 },
  ]
  expect(statsOf(samples, 20)).toEqual({
    p50: 2,
    p99: 9,
    max: 9,
    rps: 200,
    errors: 2,
    statuses: [500, 404],
    timeouts: 0,
  })
})

it("a timed-out request counts as a timeout, not as a non-2xx status, and keeps its time", () => {
  const samples = [
    { ms: 10_000, status: TIMEOUT },
    { ms: 5, status: 200 },
  ]
  expect(statsOf(samples, 10_000)).toMatchObject({ max: 10_000, errors: 0, statuses: [], timeouts: 1 })
})

it("an error at either concurrency fails the route", () => {
  const bad: Result = { key: "GET /notes", cube: "notes", c1: stats(1), c20: stats(1, 3) }
  expect(errorFindings([bad, result("POST /notes", 1, 1)], {})).toEqual(["GET /notes: 3 non-2xx answers (500)"])
})

it("a timeout fails the route and names the fixture it was called with", () => {
  const slow: Result = { key: "GET /links", cube: "links", c1: stats(1), c20: stats(10_000, 0, 2) }
  expect(errorFindings([slow], { "GET /links": { query: { q: "x" } } })).toEqual([
    'GET /links: 2 requests timed out, fixture {"query":{"q":"x"}}',
  ])
})

it("budgets: the override wins over the default, each level is held separately", () => {
  const budgets = { default: { c1: 10, c20: 50 }, routes: { "POST /auth/login": { c1: 100, c20: 900 } } }
  expect(
    budgetFindings(
      [result("GET /notes", 10, 51), result("POST /auth/login", 99, 800), result("GET /x", 11, 5)],
      budgets,
    ),
  ).toEqual([
    "GET /notes: p99 51.0 ms at concurrency 20, budget 50 ms",
    "GET /x: p99 11.0 ms at concurrency 1, budget 10 ms",
  ])
})

it("the verdict fails the run on any finding and counts both kinds", () => {
  expect(verdict({ failures: [], overBudget: [] })).toEqual([])
  expect(verdict({ failures: ["a", "b"], overBudget: ["c"] })).toEqual(["2 failures, 1 over budget; listed above"])
})

it("sorts slowest p99 at concurrency 20 first", () => {
  expect(byP99([result("a", 9, 1), result("b", 1, 9)]).map(({ key }) => key)).toEqual(["b", "a"])
})
