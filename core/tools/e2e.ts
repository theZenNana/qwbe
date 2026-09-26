import { join, resolve } from "node:path"
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Effect from "effect/Effect"
import { runInherited } from "./build.ts"
import { reportFailure } from "./process.ts"

const root = resolve(import.meta.dirname, "../..")
// The API port qwbe.spec.mjs starts; the web build bakes it in.
const E2E_API = "http://127.0.0.1:4520"

// Extra arguments go to playwright: `node core/tools/e2e.ts --grep login`.
const main = runInherited(join(root, "web"), ["npm", "run", "build"], { NEXT_PUBLIC_QWBE_API: E2E_API }).pipe(
  Effect.zipRight(runInherited(root, ["npx", "playwright", "test", ...process.argv.slice(2)])),
  Effect.catchAll(reportFailure),
)

if (process.argv[1] === import.meta.filename) NodeRuntime.runMain(main.pipe(Effect.provide(NodeContext.layer)))
