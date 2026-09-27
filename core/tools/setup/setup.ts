// Entry point: `node core/tools/setup/setup.ts`, started by `npm run setup` through bootstrap.mjs.
import { fileURLToPath } from "node:url"
import * as FileSystem from "@effect/platform/FileSystem"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { inherit } from "../shared/process.ts"
import { runTool } from "../shared/run-tool.ts"
import {
  dataDirFor,
  INSTALL_ARGV,
  INSTALL_DIRS,
  installFailedMessage,
  meetsRequired,
  nodeOkMessage,
  tooOldMessage,
} from "./setup-pure.ts"

class SetupFailed extends Data.TaggedError("SetupFailed")<{ readonly message: string }> {}

const checkNode = (version: string) =>
  meetsRequired(version)
    ? Console.log(nodeOkMessage(version))
    : Effect.fail(new SetupFailed({ message: tooOldMessage(version) }))

const install = (root: string, dir: string) =>
  Console.log(`npm ci in ${dir}`).pipe(
    Effect.zipRight(inherit(INSTALL_ARGV, `${root}${dir}`)),
    Effect.filterOrFail(
      (status) => status === 0,
      (status) => new SetupFailed({ message: installFailedMessage(dir, status) }),
    ),
  )

const makeDataDir = (dir: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeDirectory(dir, { recursive: true })).pipe(
    Effect.zipRight(Console.log(`data directory: ${dir}`)),
  )

const root = fileURLToPath(new URL("../../..", import.meta.url))

// In order; the first failure stops the rest.
const stages = [
  checkNode(process.versions.node),
  ...INSTALL_DIRS.map((dir) => install(root, dir)),
  Config.option(Config.string("QWBE_DATA_DIR")).pipe(
    Effect.orDie,
    Effect.flatMap((fromEnv) => makeDataDir(dataDirFor(root, Option.getOrUndefined(fromEnv)))),
  ),
]

runTool(Effect.as(Effect.all(stages), 0))
