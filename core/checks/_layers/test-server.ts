import * as FetchHttpClient from "@effect/platform/FetchHttpClient"
import type * as FileSystem from "@effect/platform/FileSystem"
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { boot } from "./boot.ts"
import { Workspace, workspace } from "./workspace.ts"

export { ServerDidNotStart, USERS } from "./boot.ts"

/** The real server (core/src/main.ts) on a free port, plus the workspace it runs over. */
export class TestServer extends Context.Tag("TestServer")<
  TestServer,
  Workspace["Type"] & { readonly base: string }
>() {}

/** Puts packs into the plugins directory before the server boots, so discovery mounts them. */
export type Plant<E> = (pluginsDir: string) => Effect.Effect<void, E, FileSystem.FileSystem>

const server = <E>(env: Readonly<Record<string, string>>, plant: Plant<E>) =>
  Effect.gen(function* () {
    const dirs = yield* Workspace
    yield* plant(dirs.pluginsDir)
    return { ...dirs, base: yield* boot(env) }
  })

/**
 * A workspace with FileSystem, CommandExecutor and an HttpClient, but no server: for a check
 * that boots `boot()` itself, e.g. twice on the same database.
 */
export const testWorkspace = (label: string) =>
  workspace(label).pipe(Layer.provideMerge(Layer.merge(NodeContext.layer, FetchHttpClient.layer)))

/**
 * One booted server per test file, with an HttpClient for `api-client.ts`; its database,
 * directories and process die with the file. Use it as
 * `layer(testServer(label, env, plant), { excludeTestServices: true })`: the default TestClock
 * never advances on its own, so the readiness wait would stall.
 */
export const testServer = <E = never>(
  label: string,
  env: Readonly<Record<string, string>> = {},
  plant: Plant<E> = () => Effect.void,
) => Layer.scoped(TestServer, server(env, plant)).pipe(Layer.provideMerge(testWorkspace(label)))
