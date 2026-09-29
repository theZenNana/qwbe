// `npm run bench:api`: every route of the OpenAPI spec of a real server with crm-pack installed,
// on a throwaway database seeded to apiBench.rows per list cube, timed at concurrency 1 and 20.
// Prints p50/p99/max per route, writes the same as JSON to apiBench.report, and exits 1 on a missing
// fixture, a non-2xx answer, a timed-out request or a p99 over its budget. A timeout fails its route,
// not the run: every route is measured. This file only composes the others in this folder.
import { join, resolve } from "node:path"
import * as FileSystem from "@effect/platform/FileSystem"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { type Session, sessionAs } from "../../checks/_layers/session.ts"
import { TestServer, testServer } from "../../checks/_layers/test-server.ts"
import type { ApiBench, QwbeConfig } from "../shared/config.ts"
import { readConfig } from "../shared/config.ts"
import { runTool } from "../shared/run-tool.ts"
import { ApiBenchFailed, failIfAny } from "./failed.ts"
import { benchRoute, ROOT, type Sessions } from "./measure.ts"
import { printResults, writeReport } from "./report.ts"
import { coverage, fixturedRoutes, OpenApi, routesOf } from "./routes.ts"
import { seedAll, seedSteps } from "./seed.ts"
import { findingsOf, verdict } from "./stats.ts"

// crm-pack is a sibling checkout of this repo.
const CRM_PACK = resolve(ROOT, "../plugins/crm-pack")

// The legacy migrations a fresh database refuses without the operator's word; as crm-pack's live checks boot.
const LEGACY = "bookmarks:example-plugin,tags:example-plugin,contacts:crm-pack,contracts:crm-pack,crm/accounts:crm-pack"

const requireApiBench = ({ apiBench }: typeof QwbeConfig.Type) =>
  apiBench === undefined
    ? Effect.fail(new ApiBenchFailed({ message: "qwbe.yaml has no apiBench" }))
    : Effect.succeed(apiBench)

const benchConfig = Effect.flatMap(readConfig(join(ROOT, "qwbe.yaml")), requireApiBench)

// cubes/ and qwbe-package.json only, as crm-pack's own live checks plant it.
const plantCrmPack = (pluginsDir: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    Effect.zipRight(
      fs.copy(join(CRM_PACK, "cubes"), join(pluginsDir, "crm-pack", "cubes")),
      fs.copy(join(CRM_PACK, "qwbe-package.json"), join(pluginsDir, "crm-pack", "qwbe-package.json")),
    ),
  )

const specRoutes = (admin: Session) =>
  Effect.map(
    Effect.flatMap(admin.get("/openapi.json"), ({ body }) => Schema.decodeUnknown(OpenApi)(body)),
    routesOf,
  )

const openSessions = (base: string) =>
  Effect.all({ admin: sessionAs(base, "admin"), reader: sessionAs(base, "reader") })

const measureAll = (
  sessions: Sessions,
  measured: ReturnType<typeof fixturedRoutes>,
  requests: typeof ApiBench.Type.requests,
) => Effect.forEach(measured, ({ route, fixture }) => benchRoute(sessions, route, fixture, requests))

const bench = (config: typeof ApiBench.Type) =>
  Effect.gen(function* () {
    const { base, url } = yield* TestServer
    const sessions = yield* openSessions(base)
    const routes = yield* specRoutes(sessions.admin)
    yield* failIfAny(coverage(routes, config))
    yield* seedAll(sessions, url, seedSteps(routes, config))
    yield* Console.log(`${routes.length} routes, seeded ${config.rows} rows per list cube; measuring`)
    const results = yield* measureAll(sessions, fixturedRoutes(routes, config.routes), config.requests)
    const findings = findingsOf(results, config.routes, config.budgets)
    yield* printResults(results, findings)
    const report = join(ROOT, config.report)
    yield* writeReport(report, results, findings)
    yield* Console.log(`report: ${report}`)
    yield* failIfAny(verdict(findings))
    return 0
  })

// The config is read before the boot, so a broken qwbe.yaml fails in a second, not after it.
const program = Effect.flatMap(benchConfig, (config) =>
  Effect.provide(bench(config), testServer("apibench", { QWBE_LEGACY_MIGRATIONS: LEGACY }, plantCrmPack)),
)

runTool(program, "api-bench: ")
