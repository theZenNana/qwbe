// The server. Deliberately thin: discover, mount, check, serve.
//
// What is NOT in this file, and it is the whole point: no list of cube names, no default
// mount list, no reference to `auth`, `account`, `notes` or any other. This file does not know
// which cubes exist. It finds them on disk at startup.
//
//   node src/main.ts                                   every cube in cubes/ and plugins/
//   QWBE_MOUNTED=auth,settings node src/main.ts       only those two -- the rest do not exist
//   rm -rf src/cubes/notes && node src/main.ts         starts, with nothing edited anywhere

import { createServer } from "node:http"
import { HttpApiBuilder, HttpApiSwagger, HttpMiddleware, HttpServer } from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import { loadDefinitions, mount } from "./kernel/discovery.ts"
import { buildApi, buildHandlers, checkCubes, rejectDisabled } from "./kernel/mount.ts"
import { type RegistryEntry, registryFrom } from "./kernel/registry.ts"
import { loadSpaces } from "./kernel/space.ts"

const PORT = Number(process.env.QWBE_PORT ?? 4500)

const fail = (e: Error, code: number): never => {
  console.error(`\n${e.message}\n`)
  process.exit(code)
}

// --- 1. discovery: level 0 (cubes + plugins) and level 1 (spaces) ---

const definitions = await loadDefinitions().catch((e: Error) => fail(e, 2))
const spaces = await loadSpaces().catch((e: Error) => fail(e, 2))

// --- 2. mount: unique tables, single privilege, switches, per-cube tools ---

let system: ReturnType<typeof mount>
try {
  system = mount(definitions, spaces)
} catch (e) {
  fail(e as Error, 2)
}

// --- 3. life rules. Any failure and the server does NOT start ---

let dangling: ReadonlyArray<{ space: string; from: string; to: string; reason: string }> = []
try {
  dangling = checkCubes(system!.cubes, spaces)
} catch (e) {
  fail(e as Error, 1)
}

// A link whose other end is gone is a warning, never fatal: a cube must be removable by
// deleting its directory, and a space belongs to neither side. Printed loudly so a typo does
// not hide as an empty list in the UI.
if (dangling.length > 0) {
  console.warn(
    `\n⚠ ${dangling.length} link(s) point nowhere and are inactive:\n` +
      dangling.map((d) => `    space "${d.space}": ${d.from} -> ${d.to} -- ${d.reason}`).join("\n") +
      `\n  Either a typo, or the cube holding that entity was removed. The system runs without them.\n`,
  )
}

const api = buildApi(system!.cubes)

const bySource = system!.cubes.map((c) => (c.plugin ? `${c.name}(${c.plugin})` : c.name))
console.log(
  `cubes: mounting [${bySource.join(", ")}] on port ${PORT}\n` +
    `       spaces: ${spaces.map((s) => s.name).join(", ") || "none"} - ` +
    `${system!.liveLinks().length} live link(s)\n` +
    `       permissions aggregated from manifests: ${system!.permissions.size}\n` +
    `       commands aggregated from manifests: ${system!.commands().length}\n` +
    `       switched off: [${system!.switches
      .list()
      .filter((c) => !c.enabled)
      .map((c) => c.name)
      .join(", ")}]`,
)

// --- 4. layers ---

const entries: ReadonlyArray<RegistryEntry> = system!.cubes.map((c) => ({
  name: c.name,
  entity: c.manifest.entity,
  relational: c.parts.relational,
}))

const RegistryLive = registryFrom(entries, system!.liveLinks, system!.isEnabled)

// Layers contributed by cubes. In practice: `AuthorizationLive` from the auth cube. With auth
// unmounted the list is empty -- and then no cube asks for the tag either, because `checkCubes`
// would already have stopped startup.
//
// They get the registry too: the auth cube reads user data the same way any cube would --
// through the registry, never by opening the account cube's database.
const CubeLayers = system!.cubes
  .map((c) => c.parts.layers)
  .filter((l): l is Layer.Layer<never, never, never> => !!l)
  .map((l) => l.pipe(Layer.provide(RegistryLive)))

const HandlersLive = buildHandlers(api, system!.cubes).pipe(Layer.provide(RegistryLive))

// Two spreads of an unknown-length array were being asked of types that want a fixed shape:
// `pipe` takes a fixed list of steps, `mergeAll` a non-empty tuple. The cast said "trust me,
// there is one" -- and a cast is a promise the compiler cannot keep. Written out, the branch is
// visible: no cube layers, no extra `provide`.
const withHandlers = HttpApiBuilder.api(api).pipe(Layer.provide(HandlersLive))
const [firstCubeLayer, ...restCubeLayers] = CubeLayers
const ApiLive =
  firstCubeLayer === undefined
    ? withHandlers
    : withHandlers.pipe(Layer.provide(Layer.mergeAll(firstCubeLayer, ...restCubeLayers)))

// --- 5. the server ---

const ServerLive = HttpApiBuilder.serve((app) =>
  HttpMiddleware.logger(rejectDisabled(system!.cubes, system!.isEnabled)(app)),
).pipe(
  Layer.provide(HttpApiSwagger.layer({ path: "/docs" })),
  Layer.provide(HttpApiBuilder.middlewareOpenApi({ path: "/openapi.json" })),
  // The web app is a sibling process on another port; without CORS they do not speak.
  Layer.provide(
    HttpApiBuilder.middlewareCors({
      allowedOrigins: ["*"],
      allowedHeaders: ["Content-Type", "Authorization"],
      allowedMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    }),
  ),
  Layer.provide(ApiLive),
  HttpServer.withLogAddress,
  Layer.provide(NodeHttpServer.layer(() => createServer(), { port: PORT })),
)

NodeRuntime.runMain(Layer.launch(ServerLive))
