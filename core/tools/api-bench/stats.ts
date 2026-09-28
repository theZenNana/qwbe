// The numbers of the API benchmark: samples to stats, percentiles, and the error and budget findings.
import type { ApiBench, Fixture } from "../shared/config.ts"

/** The status of a request that got no answer within the client's timeout. */
export const TIMEOUT = 0

/** One timed request: its duration and its status, TIMEOUT when no answer came. */
export interface Sample {
  readonly ms: number
  readonly status: number
}

export interface Stats {
  readonly p50: number
  readonly p99: number
  readonly max: number
  readonly rps: number
  readonly errors: number
  readonly statuses: ReadonlyArray<number>
  readonly timeouts: number
}

/** Nearest-rank percentile of an ascending array. */
export const percentile = (sorted: ReadonlyArray<number>, p: number) =>
  sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0

export const isOk = (status: number) => status >= 200 && status < 300

const ascendingMs = (samples: ReadonlyArray<Sample>) => samples.map(({ ms }) => ms).sort((a, b) => a - b)

// A timeout is counted apart, never as a non-2xx status.
const badStatuses = (samples: ReadonlyArray<Sample>) =>
  samples.filter(({ status }) => status !== TIMEOUT && !isOk(status)).map(({ status }) => status)

const perSecond = (count: number, wallMs: number) => (wallMs > 0 ? (count * 1000) / wallMs : 0)

/** The numbers of one measured run of `samples`, which took `wallMs` in all. */
export const statsOf = (samples: ReadonlyArray<Sample>, wallMs: number): Stats => {
  const sorted = ascendingMs(samples)
  const bad = badStatuses(samples)
  return {
    p50: percentile(sorted, 50),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? 0,
    rps: perSecond(samples.length, wallMs),
    errors: bad.length,
    statuses: [...new Set(bad)],
    timeouts: samples.filter(({ status }) => status === TIMEOUT).length,
  }
}

export interface Result {
  readonly key: string
  readonly cube: string
  readonly c1: Stats
  readonly c20: Stats
}

type Fixtures = Readonly<Record<string, typeof Fixture.Type>>

type Budgets = typeof ApiBench.Type.budgets

const non2xx = (key: string, c1: Stats, c20: Stats) => {
  const errors = c1.errors + c20.errors
  const statuses = [...new Set([...c1.statuses, ...c20.statuses])].join(", ")
  return errors === 0 ? [] : [`${key}: ${errors} non-2xx answers (${statuses})`]
}

const timedOut = (key: string, c1: Stats, c20: Stats, fixture: typeof Fixture.Type | undefined) => {
  const timeouts = c1.timeouts + c20.timeouts
  return timeouts === 0 ? [] : [`${key}: ${timeouts} requests timed out, fixture ${JSON.stringify(fixture ?? {})}`]
}

/** A non-2xx or a timeout is a failure, never a timing; a timeout names the fixture the route was called with. */
export const errorFindings = (results: ReadonlyArray<Result>, fixtures: Fixtures) =>
  results.flatMap(({ key, c1, c20 }) => [...non2xx(key, c1, c20), ...timedOut(key, c1, c20, fixtures[key])])

const over = (key: string, level: string, p99: number, budget: number) =>
  p99 <= budget ? [] : [`${key}: p99 ${p99.toFixed(1)} ms at concurrency ${level}, budget ${budget} ms`]

/** Every route whose p99 breaks its budget (its override, else the default), one line per level. */
export const budgetFindings = (results: ReadonlyArray<Result>, budgets: Budgets) =>
  results.flatMap(({ key, c1, c20 }) => {
    const budget = budgets.routes[key] ?? budgets.default
    return [...over(key, "1", c1.p99, budget.c1), ...over(key, "20", c20.p99, budget.c20)]
  })

export interface Findings {
  readonly failures: ReadonlyArray<string>
  readonly overBudget: ReadonlyArray<string>
}

export const findingsOf = (results: ReadonlyArray<Result>, fixtures: Fixtures, budgets: Budgets): Findings => ({
  failures: errorFindings(results, fixtures),
  overBudget: budgetFindings(results, budgets),
})

/** The line that fails the run once the findings are printed; none when there are none. */
export const verdict = ({ failures, overBudget }: Findings) =>
  failures.length + overBudget.length === 0
    ? []
    : [`${failures.length} failures, ${overBudget.length} over budget; listed above`]

/** Slowest first: descending p99 at concurrency 20. */
export const byP99 = (results: ReadonlyArray<Result>) => [...results].sort((a, b) => b.c20.p99 - a.c20.p99)
