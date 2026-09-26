// Entry point: `node core/tools/e2e.ts [playwright args]`. Builds the web app against the API port
// qwbe.spec.mjs starts (baked in at build time), then runs playwright; the first failure stops it.
import { fileURLToPath } from "node:url"
import * as Effect from "effect/Effect"
import { inheritOk } from "./process.ts"
import { runTool } from "./run-tool.ts"

const E2E_API = "http://127.0.0.1:4520"

const buildWeb = (root: string) => inheritOk(["npm", "run", "build"], `${root}web`, { NEXT_PUBLIC_QWBE_API: E2E_API })

const playwright = (root: string, args: ReadonlyArray<string>) =>
  inheritOk(["npx", "playwright", "test", ...args], root)

const root = fileURLToPath(new URL("../..", import.meta.url))

runTool(Effect.as(Effect.all([buildWeb(root), playwright(root, process.argv.slice(2))]), 0), "e2e: ")
