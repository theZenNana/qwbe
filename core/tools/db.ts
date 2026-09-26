// Entry point: `node core/tools/db.ts <up|down|clean>`. up/down run docker compose on the local
// Postgres; clean drops the test databases killed runs leaked (QWBE_PG_* picks the server).
// Orphan kernel processes stay out on purpose: a kill pattern is one typo from a legitimate suite.
import { fileURLToPath } from "node:url"
import type { CommandExecutor } from "@effect/platform/CommandExecutor"
import type { PlatformError } from "@effect/platform/Error"
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import type { ParseError } from "effect/ParseResult"
import * as Schema from "effect/Schema"
import pg from "pg"
import { adminUrl, COMPOSE_ARGV, cleanSummary, dropStatement, LEAK_PREFIXES, leakSearch } from "./db-pure.ts"
import { type Argv, GateFailed, inheritOk } from "./process.ts"

class DbFailed extends Data.TaggedError("DbFailed")<{ readonly message: string }> {}

const Subcommand = Schema.Literal("up", "down", "clean")

const failed = (error: unknown) => new DbFailed({ message: `db clean: ${String(error)}` })

const connect = (url: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const client = new pg.Client({ connectionString: url })
        await client.connect()
        return client
      },
      catch: failed,
    }),
    (client) => Effect.ignore(Effect.tryPromise(() => client.end())),
  )

const query = (client: pg.Client, text: string, values: ReadonlyArray<string>) =>
  Effect.tryPromise({ try: () => client.query<{ datname: string }>(text, [...values]), catch: failed })

const findLeaks = (client: pg.Client) => {
  const { text, values } = leakSearch(LEAK_PREFIXES)
  return Effect.map(query(client, text, values), ({ rows }) => rows.map((row) => row.datname))
}

const drop = (client: pg.Client, name: string) =>
  query(client, dropStatement(name), []).pipe(Effect.zipRight(Console.log(`db clean: dropped ${name}`)))

const dropAll = (client: pg.Client, names: ReadonlyArray<string>) =>
  Effect.forEach(names, (name) => drop(client, name), { discard: true })

const clean = (url: string) =>
  Effect.scoped(
    Effect.flatMap(connect(url), (client) =>
      findLeaks(client).pipe(
        Effect.tap((names) => dropAll(client, names)),
        Effect.flatMap((names) => Console.log(cleanSummary(names.length))),
      ),
    ),
  )

const compose = (argv: Argv, root: string) => Effect.asVoid(inheritOk(argv, root))

const commands = (
  root: string,
  pgUrl: string,
): Record<
  typeof Subcommand.Type,
  Effect.Effect<void, GateFailed | DbFailed | PlatformError | ParseError, CommandExecutor>
> => ({
  up: compose(COMPOSE_ARGV.up, root),
  down: compose(COMPOSE_ARGV.down, root),
  clean: clean(pgUrl),
})

const root = fileURLToPath(new URL("../..", import.meta.url))
const { QWBE_PG_HOST, QWBE_PG_PORT, QWBE_PG_USER, QWBE_PG_PASSWORD } = process.env
const usage = new GateFailed({ message: "usage: node core/tools/db.ts <up|down|clean>", status: 2 })

Schema.decodeUnknown(Subcommand)(process.argv[2]).pipe(
  Effect.mapError(() => usage),
  Effect.flatMap(
    (subcommand) => commands(root, adminUrl(QWBE_PG_HOST, QWBE_PG_PORT, QWBE_PG_USER, QWBE_PG_PASSWORD))[subcommand],
  ),
  Effect.tapError((error) => Console.error(error.message)),
  Effect.isFailure,
  Effect.tap((isFailed) => Effect.sync(() => (process.exitCode = isFailed ? 1 : 0))),
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain,
)
