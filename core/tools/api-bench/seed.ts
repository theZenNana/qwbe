// The seeding of the API benchmark: each seed's template row made through the API, then cloned in SQL.
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { connect, query } from "../../checks/_layers/postgres.ts"
import type { ApiBench, Fixture, Seed } from "../shared/config.ts"
import { failIfAny } from "./failed.ts"
import { type Sessions, send } from "./measure.ts"
import type { Route } from "./routes.ts"
import { Columns, cloneSql, columnsSql, ownershipSql, tableIdent } from "./seed-sql.ts"
import { isOk } from "./stats.ts"

interface Template {
  readonly route: Route
  readonly fixture: typeof Fixture.Type
}

/** One seed with its row count and the request that makes its template row, if it has one. */
export interface SeedStep {
  readonly seed: typeof Seed.Type
  readonly rows: number
  readonly template: Template | undefined
}

const templateOf = (routes: ReadonlyArray<Route>, fixtures: typeof ApiBench.Type.routes, key: string | undefined) => {
  const route = routes.find((candidate) => candidate.key === key)
  const fixture = key === undefined ? undefined : fixtures[key]
  return route === undefined || fixture === undefined ? undefined : { route, fixture }
}

/** The seeds in their order, each with its rows (its own, else `rows`) and its template request. */
export const seedSteps = (
  routes: ReadonlyArray<Route>,
  { seeds, rows, routes: fixtures }: Pick<typeof ApiBench.Type, "seeds" | "rows" | "routes">,
): ReadonlyArray<SeedStep> =>
  seeds.map((seed) => ({ seed, rows: seed.rows ?? rows, template: templateOf(routes, fixtures, seed.create) }))

const createFindings = (key: string, { status, body }: { readonly status: number; readonly body: unknown }) =>
  isOk(status) ? [] : [`seed create ${key} answered ${status}: ${JSON.stringify(body)}`]

// The template row of a seed, made through the API so its body and owner are what the code writes.
const createTemplate = (sessions: Sessions, { route, fixture }: Template) =>
  Effect.flatMap(send(sessions, route, fixture, 0), (answer) => failIfAny(createFindings(route.key, answer)))

type Client = Effect.Effect.Success<ReturnType<typeof connect>>

const columnsOf = (client: Client, table: string) =>
  Effect.flatMap(query(client, columnsSql(table)), ({ rows }) => Schema.decodeUnknown(Columns)(rows))

// ponytail: one INSERT ... generate_series per table clones one real row; the clones share its body shape and
// owner, so lists and searches run on uniform rows. Varied bodies if a plan ever depends on the data spread.
const seedTable = (client: Client, seed: typeof Seed.Type, rows: number) =>
  Effect.gen(function* () {
    const columns = yield* columnsOf(client, seed.table)
    if (columns.length === 0) return yield* failIfAny([`apiBench.seeds: table ${seed.table} does not exist`])
    const cloned = yield* query(client, cloneSql(seed, columns, rows))
    if (cloned.rowCount === 0) return yield* failIfAny([`apiBench.seeds: ${seed.table} has no row to clone`])
    yield* query(client, ownershipSql(seed))
    yield* query(client, `ANALYZE ${tableIdent(seed.table)}`)
  })

const seedStep = (sessions: Sessions, client: Client, { seed, rows, template }: SeedStep) =>
  Effect.zipRight(
    template === undefined ? Effect.void : createTemplate(sessions, template),
    seedTable(client, seed, rows),
  )

// In order: a later seed's create may name an earlier seed's rows (a comment on note-bench1).
export const seedAll = (sessions: Sessions, url: string, steps: ReadonlyArray<SeedStep>) =>
  Effect.scoped(
    Effect.flatMap(connect(url), (client) =>
      Effect.forEach(steps, (step) => seedStep(sessions, client, step), { discard: true }).pipe(
        Effect.zipRight(query(client, "ANALYZE")),
      ),
    ),
  )
