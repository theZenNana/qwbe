import { resolve } from "node:path"
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Effect from "effect/Effect"
import { runInherited } from "./build.ts"
import { GateFailed, reportFailure } from "./process.ts"

const root = resolve(import.meta.dirname, "../..")

/** The docker compose argv of a db subcommand; undefined for anything else. */
export const composeArgv = (subcommand: string | undefined) =>
  subcommand === "up"
    ? (["docker", "compose", "up", "-d", "postgres"] as const)
    : subcommand === "down"
      ? (["docker", "compose", "down"] as const)
      : undefined

const main = Effect.suspend(() => {
  const argv = composeArgv(process.argv[2])
  return argv === undefined
    ? Effect.fail(new GateFailed({ message: "usage: node core/tools/db.ts <up|down>", status: 2 }))
    : runInherited(root, argv)
}).pipe(Effect.catchAll(reportFailure))

if (process.argv[1] === import.meta.filename) NodeRuntime.runMain(main.pipe(Effect.provide(NodeContext.layer)))
