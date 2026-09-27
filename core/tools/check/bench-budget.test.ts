import { expect, it } from "@effect/vitest"
import { BENCH, mediansOf, overBudget } from "./bench-budget-pure.ts"

const budgets = {
  list60k: { deepPageFloorMs: 250, deepPageFactor: 4, anyAnswerMs: 1000 },
  stagingImport: { minRowsPerSecond: 10_000 },
}

// 100,000 rows in 5 s is 20,000 rows/s, twice the budget.
const green = new Map([
  [BENCH.listFirst, 20],
  [BENCH.listDeep, 200],
  [`${BENCH.listPrefix} prefix search`, 30],
  [BENCH.stagingImport, 5000],
])

const withMedian = (name: string, median: number) => new Map([...green, [name, median]])

it("a report inside every budget has no findings", () => {
  expect(overBudget(green, budgets)).toEqual([])
})

it("a deep page over max(floor, factor x first page) is named with both medians", () => {
  expect(overBudget(withMedian(BENCH.listDeep, 260), budgets)).toEqual([
    `${BENCH.listDeep}: median 260.0 ms, budget under 250.0 ms (max of 250 ms and 4 x page 1 at 20.0 ms)`,
  ])
})

it("the factor lifts the deep-page budget above the floor when page 1 is slow", () => {
  expect(overBudget(new Map([...withMedian(BENCH.listFirst, 100), [BENCH.listDeep, 390]]), budgets)).toEqual([])
})

it("any list answer over anyAnswerMs is named", () => {
  expect(overBudget(withMedian(`${BENCH.listPrefix} prefix search`, 1000), budgets)).toEqual([
    `${BENCH.listPrefix} prefix search: median 1000.0 ms, budget under 1000 ms`,
  ])
})

it("an import slower than minRowsPerSecond is named with its rate", () => {
  expect(overBudget(withMedian(BENCH.stagingImport, 20_000), budgets)).toEqual([
    `${BENCH.stagingImport}: 5000 rows/s (median 20000.0 ms for 100000 rows), budget at least 10000 rows/s`,
  ])
})

it("a bench missing from the report is a finding, never a silent pass", () => {
  expect(overBudget(new Map(), budgets)).toEqual([
    `${BENCH.listFirst}: no result in the bench report`,
    `${BENCH.listDeep}: no result in the bench report`,
    `${BENCH.stagingImport}: no result in the bench report`,
  ])
})

it("reads each benchmark's median by name across files and groups", () => {
  const report = {
    files: [
      { groups: [{ benchmarks: [{ name: "a", median: 1 }] }] },
      { groups: [{ benchmarks: [{ name: "b", median: 2 }] }, { benchmarks: [] }] },
    ],
  }
  expect([...mediansOf(report)]).toEqual([
    ["a", 1],
    ["b", 2],
  ])
})
