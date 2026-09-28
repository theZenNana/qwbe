// Entry point: `node core/tools/db/db.ts <up|down|clean>`. up/down run docker compose on the local
// Postgres; clean drops the test databases killed runs leaked (QWBE_PG_* picks the server).
// Orphan kernel processes stay out on purpose: a kill pattern is one typo from a legitimate suite.
import { fileURLToPath } from "node:url"
import type { CommandExecutor } from "@effect/platform/CommandExecutor"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { adminUrl } from "../../src/pg/admin-url.ts"
import { GateFailed, inheritOk } from "../shared/process.ts"
import { runTool } from "../shared/run-tool.ts"
import { clean } from "./db-clean.ts"
import { COMPOSE_STEPS } from "./db-pure.ts"

const Subcommand = Schema.Literal("up", "down", "clean")

const root = fileURLToPath(new URL("../../..", import.meta.url))
const usage = new GateFailed({ message: "usage: node core/tools/db/db.ts <up|down|clean>", status: 2 })

const run = (subcommand: typeof Subcommand.Type): Effect.Effect<void, { readonly message: string }, CommandExecutor> =>
  subcommand === "clean"
    ? Effect.flatMap(Effect.orDie(adminUrl), clean)
    : Effect.forEach(COMPOSE_STEPS[subcommand], (argv) => inheritOk(argv, root), { discard: true })

runTool(
  Schema.decodeUnknown(Subcommand)(process.argv[2]).pipe(
    Effect.mapError(() => usage),
    Effect.flatMap(run),
    Effect.as(0),
  ),
)
