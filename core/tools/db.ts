// Entry point: `node core/tools/db.ts <up|down|clean>`. up/down run docker compose on the local
// Postgres; clean drops the test databases killed runs leaked (QWBE_PG_* picks the server).
// Orphan kernel processes stay out on purpose: a kill pattern is one typo from a legitimate suite.
import { fileURLToPath } from "node:url"
import type { CommandExecutor } from "@effect/platform/CommandExecutor"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { clean } from "./db-clean.ts"
import { adminUrl, COMPOSE_ARGV } from "./db-pure.ts"
import { GateFailed, inheritOk } from "./process.ts"
import { runTool } from "./run-tool.ts"

const Subcommand = Schema.Literal("up", "down", "clean")

const root = fileURLToPath(new URL("../..", import.meta.url))
const { QWBE_PG_HOST, QWBE_PG_PORT, QWBE_PG_USER, QWBE_PG_PASSWORD } = process.env
const usage = new GateFailed({ message: "usage: node core/tools/db.ts <up|down|clean>", status: 2 })

const run = (subcommand: typeof Subcommand.Type): Effect.Effect<void, { readonly message: string }, CommandExecutor> =>
  subcommand === "clean"
    ? clean(adminUrl(QWBE_PG_HOST, QWBE_PG_PORT, QWBE_PG_USER, QWBE_PG_PASSWORD))
    : Effect.asVoid(inheritOk(COMPOSE_ARGV[subcommand], root))

runTool(
  Schema.decodeUnknown(Subcommand)(process.argv[2]).pipe(
    Effect.mapError(() => usage),
    Effect.flatMap(run),
    Effect.as(0),
  ),
)
