import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import type { TestProject } from "vitest/node"
import { TestServer, testServer } from "../_layers/test-server.ts"

declare module "vitest" {
  export interface ProvidedContext {
    readonly benchServer: { readonly base: string; readonly url: string }
  }
}

const close = (scope: Scope.CloseableScope) => Scope.close(scope, Exit.void)

// A boot that fails halfway still stops what it started and drops its database.
const bootInto = (scope: Scope.CloseableScope) =>
  Layer.buildWithScope(testServer("bench"), scope).pipe(
    Effect.map((context) => Context.get(context, TestServer)),
    Effect.onError(() => close(scope)),
  )

/**
 * Global setup of vitest.bench.config.ts: one real server for both benches, published to them as
 * `inject("benchServer")`. The returned teardown stops the server and drops its database.
 */
export default async function setup(project: TestProject) {
  const scope = Effect.runSync(Scope.make())
  const { base, url } = await Effect.runPromise(bootInto(scope))
  project.provide("benchServer", { base, url })
  return () => Effect.runPromise(close(scope))
}
