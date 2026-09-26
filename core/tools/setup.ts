// One installation step for the whole project, started by core/tools/bootstrap.ts once core is
// installed (this file imports Effect from core/node_modules). It checks the Node version, runs
// `npm ci` in root and web (stops at the first failure) and creates data/ (or $QWBE_DATA_DIR).

import { join, resolve } from "node:path"
import * as FileSystem from "@effect/platform/FileSystem"
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { runInherited } from "./build.ts"
import { GateFailed, reportFailure } from "./process.ts"

const root = resolve(import.meta.dirname, "../..")
// The first release that strips TypeScript types without a flag.
const REQUIRED = [22, 18, 0] as const

export const parseVersion = (version: string) =>
  version
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10))

export const isOlder = (have: ReadonlyArray<number>, want: ReadonlyArray<number>) => {
  for (const [index, wanted] of want.entries()) {
    const had = have[index] ?? 0
    if (had !== wanted) return had < wanted
  }
  return false
}

// Under `npm run`, npm hands the user's ~/.npmrc to children as npm_config_* variables, and
// npm >= 12 refuses `allow-scripts` from the environment in a project-scoped install
// (EALLOWSCRIPTS). The child npm still reads ~/.npmrc itself, so the policy stays. Upper case
// arrives too (NPM_CONFIG_ALLOW_SCRIPTS). An undefined value removes the variable for the child.
/** The environment overrides that strip allow-scripts in any case. */
export const withoutAllowScripts = (env: Readonly<Record<string, string | undefined>>) =>
  Object.fromEntries(
    Object.keys(env)
      .filter((key) => key.toLowerCase() === "npm_config_allow_scripts")
      .map((key) => [key, undefined]),
  )

const checkNode = Effect.suspend(() =>
  isOlder(parseVersion(process.versions.node), REQUIRED)
    ? Effect.fail(
        new GateFailed({
          message: `Qwbe needs Node ${REQUIRED.join(".")} or newer, you have ${process.versions.node}. Install a newer Node (nvm install 22), then run npm run setup again.`,
          status: 1,
        }),
      )
    : Console.log(`node ${process.versions.node}: ok (need >= ${REQUIRED.join(".")})`),
)

const install = (where: string) =>
  Console.log(`npm ci in ${where}/`).pipe(
    Effect.zipRight(
      runInherited(join(root, where), ["npm", "ci", "--no-audit", "--no-fund"], withoutAllowScripts(process.env)),
    ),
  )

const createDataDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const dataDir = process.env.QWBE_DATA_DIR ?? join(root, "data")
  yield* fs
    .makeDirectory(dataDir, { recursive: true })
    .pipe(
      Effect.mapError((error) => new GateFailed({ message: `cannot create ${dataDir}: ${error.message}`, status: 1 })),
    )
  yield* Console.log(`${dataDir}: ready`)
})

const main = checkNode.pipe(
  // core is already installed by core/tools/bootstrap.ts, which is how this file can import Effect.
  Effect.zipRight(Effect.forEach([".", "web"], install, { discard: true })),
  Effect.zipRight(createDataDir),
  Effect.zipRight(Console.log("\nSetup done. Start everything with: npm start")),
  Effect.catchAll(reportFailure),
)

if (process.argv[1] === import.meta.filename) NodeRuntime.runMain(main.pipe(Effect.provide(NodeContext.layer)))
