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
import {
  HttpApiBuilder,
  HttpApiSecurity,
  HttpMiddleware,
  HttpServer,
  HttpServerResponse,
  OpenApi,
} from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { bootStorage } from "./boot-storage.ts"
import { catalogueMetadata } from "./catalogue.ts"
import { Authorization } from "./kernel/auth-contract.ts"
import { loadDefinitions, mount } from "./kernel/discovery.ts"
import { readLedger, verifyLedgerUnchanged, writeLedger } from "./kernel/ledger.ts"
import { buildApi, buildHandlers, checkCubes, rejectDisabled } from "./kernel/mount.ts"
import { logRefusals } from "./kernel/refusal-log.ts"
import type { Registry, RegistryEntry } from "./kernel/registry.ts"
import { loadSpaces } from "./kernel/space.ts"
import { checkSchemaDrift } from "./metadata/schema-drift.ts"
import { corsOriginMatcher, originsForStartup } from "./origins.ts"
import { registryFrom } from "./registry-runtime.ts"

const PORT = Number(process.env.QWBE_PORT ?? 4500)

const fail = (e: Error, code: number): never => {
  console.error(`\n${e.message}\n`)
  process.exit(code)
}

// Browser origins for CORS (QWB-42): parse, warn on the unset default, exit on malformed
// values -- all in origins.ts.
const ALLOWED_ORIGINS: ReadonlyArray<string> = originsForStartup(process.env.QWBE_ALLOWED_ORIGINS)

// --- 1. discovery: level 0 (cubes + plugins) and level 1 (spaces) ---
//
// The ledger snapshot is taken FIRST, before `loadDefinitions` imports a single plugin
// module. A plugin's top-level code runs at import and can rewrite data/provenance.json --
// but it cannot rewrite this snapshot, and the migration checks below trust the snapshot.
const ledgerRead = readLedger()
const ledgerSnapshot = ledgerRead.state === "ok" ? ledgerRead.ledger : {}
const failAfterSnapshot = (e: Error, code: number): never => {
  try {
    verifyLedgerUnchanged(ledgerRead)
  } catch {
    // verifyLedgerUnchanged restored the trusted state; preserve the originating failure.
  }
  return fail(e, code)
}

const definitions = await loadDefinitions().catch((e: Error) => failAfterSnapshot(e, 2))
const spaces = await loadSpaces().catch((e: Error) => failAfterSnapshot(e, 2))
verifyLedgerUnchanged(ledgerRead)

// --- 2. storage and declared data migrations (ADR-0001), split into boot-storage.ts ---
const migrations = await bootStorage(definitions, ledgerSnapshot, fail, failAfterSnapshot)

// --- 2. mount: unique tables, single privilege, switches, per-cube tools ---

let system: ReturnType<typeof mount>
try {
  system = mount(definitions, spaces)
} catch (e) {
  failAfterSnapshot(e as Error, 2)
}

// The metadata version gate: a cube that declared a `version` may not change its schema under
// the same version -- clients cache metadata keyed by it. Runs AFTER the life rules: a boot
// the life rules reject must not leave a version record behind for a system that never served.
// The derivation goes through the catalogue's cache, so the catalogue later reads the same
// values instead of walking every contract a second time. See `metadata/schema-drift.ts`.

// --- 3. life rules. Any failure and the server does NOT start ---

let dangling: ReadonlyArray<{ space: string; from: string; to: string; reason: string }> = []
try {
  dangling = checkCubes(system!.cubes, spaces)
} catch (e) {
  failAfterSnapshot(e as Error, 1)
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

try {
  checkSchemaDrift(catalogueMetadata(system!.cubes, system!.liveLinks(), system!.isEnabled))
} catch (e) {
  failAfterSnapshot(e as Error, 1)
}

const api = buildApi(system!.cubes)

// The provenance ledger is written only after a mount that passed every life rule -- the
// record must always describe a system that really ran, and a manifest cannot write it.
verifyLedgerUnchanged(ledgerRead)
writeLedger(ledgerRead, [
  ...system!.cubes.map((c) => ({ name: c.name, plugin: c.plugin })),
  // Each completed migration's source stays attributable (QWB-54 ticket 08): the ledger
  // records it under the declaring package, so the next boot -- its source schema now
  // renamed away -- still passes the ownership rules without the operator's env.
  ...migrations.map((m) => ({ name: m.fromCube, plugin: m.declaredBy })),
])

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
  permissionExempt: c.manifest.providesIdentityDirectory === true,
}))

const RegistryLive = registryFrom(entries, system!.liveLinks, system!.isEnabled, system!.entityPermissions)

// Layers contributed by cubes. In practice: `AuthorizationLive` from the auth cube. With auth
// unmounted the list is empty -- and then no cube asks for the tag either, because `checkCubes`
// would already have stopped startup.
//
// They get the registry too: the auth cube reads user data the same way any cube would --
// through the registry, never by opening the account cube's database.
// The ONE audited type-erasure seam (QWB-19): with runtime discovery kept, the exact union of
// services cube layers provide is unknowable to TypeScript. Providers are checked per cube at
// `CubeParts.layers` (Provided inferred at defineCube, requirements bounded to `Registry`);
// this adapter widens the provided side so `mergeAll` accepts a dynamic list. The only cast
// in the kernel allowed to erase -- and the double step is deliberate: the compiler is told,
// twice, that this is where the guarantee stops.
const contributeLayer = (layer: Layer.Layer<never, unknown, never>): Layer.Layer<never, never, never> =>
  layer as unknown as Layer.Layer<never, never, never>

const CubeLayers = system!.cubes
  .map((c) => c.parts.layers)
  .filter((l): l is Layer.Layer<never, unknown, Registry> => l !== undefined)
  .map((l) => l.pipe(Layer.provide(RegistryLive)))
  .map(contributeLayer)

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

const GatedOpenApi = HttpApiBuilder.Router.use((router) =>
  Effect.gen(function* () {
    // Resolved ONCE at layer build, exactly like the auth cube resolves its registry: the
    // route handler runs outside the context the api layer captured, so the service is closed
    // over here rather than yielded per request.
    const authenticate = yield* Authorization
    const spec = OpenApi.fromApi(api)
    yield* router.get(
      "/openapi.json",
      Effect.gen(function* () {
        // The same decode the middleware machinery runs: read the Bearer token from the
        // request, hand it to the auth cube's implementation, and turn a failure into an
        // empty 401 -- the spec itself is never in the response.
        const attempt = Effect.flatMap(HttpApiBuilder.securityDecode(HttpApiSecurity.bearer), authenticate.bearer)
        return yield* Effect.catchAll(Effect.zipRight(attempt, HttpServerResponse.json(spec).pipe(Effect.orDie)), () =>
          Effect.succeed(HttpServerResponse.empty({ status: 401 })),
        )
      }),
    )
  }),
)

const ServerLive = HttpApiBuilder.serve((app) =>
  // Owner, 2026-08-31: no refusal leaves this server silently. `logRefusals` sits OUTSIDE
  // the disabled-cube filter, so it sees the final status of every request, whoever produced it.
  HttpMiddleware.logger(logRefusals(rejectDisabled(system!.cubes, system!.isEnabled)(app))),
).pipe(
  // QWB-42: browser origins come from QWBE_ALLOWED_ORIGINS. Unset means ["*"], the
  // pre-QWB-42 behaviour, so local development needs no configuration. With the variable
  // set, unlisted origins get no access-control-allow-origin header and the browser blocks
  // them. Note: this is CORS, a browser enforcement only -- it is NOT authentication, and
  // non-browser clients never send an Origin at all. The matcher (array vs predicate) is
  // chosen in origins.ts.
  Layer.provide(
    HttpApiBuilder.middlewareCors({
      allowedOrigins: corsOriginMatcher(ALLOWED_ORIGINS),
      allowedHeaders: ["Content-Type", "Authorization"],
      allowedMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    }),
  ),
  // The spec route needs the auth cube's Authorization service. Every system that can pass
  // the life rules has it (with no cube layer providing Authorization, mount refuses to
  // start), but TypeScript cannot know the merged cube layers provide it -- the same
  // unknowable union contributeLayer widens above. One cast, same justification.
  Layer.provide(
    (firstCubeLayer === undefined
      ? GatedOpenApi
      : GatedOpenApi.pipe(Layer.provide(Layer.mergeAll(firstCubeLayer, ...restCubeLayers)))) as Layer.Layer<
      never,
      never,
      never
    >,
  ),
  Layer.provide(ApiLive),
  HttpServer.withLogAddress,
  Layer.provide(NodeHttpServer.layer(() => createServer(), { port: PORT })),
)

NodeRuntime.runMain(Layer.launch(ServerLive))
