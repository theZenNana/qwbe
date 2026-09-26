// Entry point: `node core/tools/setup.ts`, started by `npm run setup` through bootstrap.mjs.
import { fileURLToPath } from "node:url"
import * as FileSystem from "@effect/platform/FileSystem"
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import { inherit } from "./process.ts"
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

const install = (root: string, dir: string) =>
  Console.log(`npm ci in ${dir}`).pipe(
    Effect.zipRight(inherit(INSTALL_ARGV, `${root}${dir}`)),
    Effect.filterOrFail(
      (status) => status === 0,
      (status) => new SetupFailed({ message: installFailedMessage(dir, status) }),
    ),
  )

const version = process.versions.node
const root = fileURLToPath(new URL("../..", import.meta.url))
const dataDir = dataDirFor(root, process.env.QWBE_DATA_DIR)

Effect.all(
  [
    meetsRequired(version)
      ? Console.log(nodeOkMessage(version))
      : Effect.fail(new SetupFailed({ message: tooOldMessage(version) })),
    Effect.forEach(INSTALL_DIRS, (dir) => install(root, dir), { discard: true }),
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeDirectory(dataDir, { recursive: true })).pipe(
      Effect.zipRight(Console.log(`data directory: ${dataDir}`)),
    ),
  ],
  { discard: true },
).pipe(
  Effect.tapError((error) => Console.error(error.message)),
  Effect.isFailure,
  Effect.tap((failed) => Effect.sync(() => (process.exitCode = failed ? 1 : 0))),
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain,
)
