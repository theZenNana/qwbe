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
import { NodeContext, NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Cause, Console, Effect, Exit, Layer, Option, Predicate } from "effect"
import { BootRefused, bootStorage, LifeRuleBroken, StorageLive } from "./boot-storage.ts"
import { QwbeConfig, QwbeConfigLive } from "./config.ts"
import { CustomFields } from "./custom-defs-reader.ts"
import { captureEntity } from "./entity-enforcement.ts"
import { Authorization } from "./kernel/auth-contract.ts"
import { loadDefinitions, mount, refusal, switchesFor } from "./kernel/discovery.ts"
import { readLedger, verifyLedgerUnchanged, writeLedger } from "./kernel/ledger.ts"
import { buildApi, buildHandlers, checkCubes, rejectDisabled } from "./kernel/mount.ts"
import { logRefusals } from "./kernel/refusal-log.ts"
import type { Registry, RegistryEntry } from "./kernel/registry.ts"
import { loadSpaces } from "./kernel/space.ts"
import { rowStateFor } from "./kernel/store.ts"
import { checkSchemaDrift } from "./metadata/schema-drift.ts"
import { corsOriginMatcher, originsForStartup } from "./origins.ts"
import { registryFrom } from "./registry-runtime.ts"
import { TracingLive, traceIdHeader } from "./tracing.ts"

const boot = Effect.gen(function* () {
  const { port, traceUrl } = yield* QwbeConfig

  // Browser origins for CORS: parse, warn on the unset default, refuse malformed values --
  // all in origins.ts.
  const allowedOrigins = yield* originsForStartup

  // --- 1. discovery: level 0 (cubes + plugins) and level 1 (spaces) ---
  //
  // The ledger snapshot is taken FIRST, before `loadDefinitions` imports a single plugin
  // module. A plugin's top-level code runs at import and can rewrite data/provenance.json --
  // but it cannot rewrite this snapshot, and the migration checks below trust the snapshot.
  const ledgerRead = yield* readLedger
  const ledgerSnapshot = ledgerRead.state === "ok" ? ledgerRead.ledger : {}
  // Every refusal after the snapshot restores the trusted ledger on its way out; the
  // restore's own failure must not replace the originating one.
  const afterSnapshot =
    (as: (message: string) => BootRefused | LifeRuleBroken) =>
    <A, E extends { readonly message: string }, R>(step: Effect.Effect<A, E, R>) =>
      step.pipe(
        Effect.mapError((e) => as(e.message)),
        Effect.tapError(() => Effect.ignore(verifyLedgerUnchanged(ledgerRead))),
      )
  const refused = afterSnapshot((message) => new BootRefused({ message }))
  const lifeRule = afterSnapshot((message) => new LifeRuleBroken({ message }))

  const definitions = yield* refused(loadDefinitions)
  const spaces = yield* refused(loadSpaces)
  yield* verifyLedgerUnchanged(ledgerRead)

  // --- 2. storage and declared data migrations (ADR-0001), split into boot-storage.ts ---
  // --- 2. mount: unique tables, single privilege, switches, per-cube tools ---
  const { migrations, system } = yield* refused(
    Effect.gen(function* () {
      const migrations = yield* bootStorage(definitions, ledgerSnapshot)
      const switches = yield* switchesFor(definitions)
      return { migrations, system: yield* mount(definitions, spaces, switches) }
    }),
  ).pipe(Effect.provide(StorageLive))

  // --- 3. life rules. Any failure and the server does NOT start ---

  const dangling = yield* lifeRule(refusal(() => checkCubes(system.cubes, spaces)))

  // A link whose other end is gone is a warning, never fatal: a cube must be removable by
  // deleting its directory, and a space belongs to neither side. Printed loudly so a typo does
  // not hide as an empty list in the UI.
  if (dangling.length > 0) {
    yield* Effect.logWarning(
      `\n${dangling.length} link(s) point nowhere and are inactive:\n` +
        dangling.map((d) => `    space "${d.space}": ${d.from} -> ${d.to} -- ${d.reason}`).join("\n") +
        `\n  Either a typo, or the cube holding that entity was removed. The system runs without them.\n`,
    )
  }

  // The metadata version gate: a cube that declared a `version` may not change its schema under
  // the same version -- clients cache metadata keyed by it. Runs AFTER the life rules: a boot
  // the life rules reject must not leave a version record behind for a system that never served.
  // The derivation goes through the catalogue's cache, so the catalogue later reads the same
  // values instead of walking every contract a second time. See `metadata/schema-drift.ts`.
  yield* lifeRule(checkSchemaDrift(system.metadata()))

  const api = buildApi(system.cubes)

  // The provenance ledger is written only after a mount that passed every life rule -- the
  // record must always describe a system that really ran, and a manifest cannot write it.
  yield* verifyLedgerUnchanged(ledgerRead)
  yield* writeLedger(ledgerRead, [
    ...system.cubes.map((c) => ({ name: c.name, plugin: c.plugin })),
    // Each completed migration's source stays attributable: the ledger
    // records it under the declaring package, so the next boot -- its source schema now
    // renamed away -- still passes the ownership rules without the operator's env.
    ...migrations.map((m) => ({ name: m.fromCube, plugin: m.declaredBy })),
  ])

  const bySource = system.cubes.map((c) => (c.plugin ? `${c.name}(${c.plugin})` : c.name))
  yield* Effect.logInfo(
    `cubes: mounting [${bySource.join(", ")}] on port ${port}\n` +
      `       spaces: ${spaces.map((s) => s.name).join(", ") || "none"} - ` +
      `${system.liveLinks().length} live link(s)\n` +
      `       permissions aggregated from manifests: ${system.permissions.size}\n` +
      `       commands aggregated from manifests: ${system.commands().length}\n` +
      `       switched off: [${system.switches
        .list()
        .filter((c) => !c.enabled)
        .map((c) => c.name)
        .join(", ")}]`,
  )

  // --- 4. layers ---

  const entries: ReadonlyArray<RegistryEntry> = system.cubes.map((c) => {
    const capture = captureEntity(c.manifest)
    return {
      name: c.name,
      entity: c.manifest.entity,
      relational: c.parts.relational,
      permissionExempt: c.manifest.providesIdentityDirectory === true,
      captureEntity: capture,
      // Echo A3: the kernel-only row-state lookup, over the cube's OWN tables and role. Built
      // here, next to the capture identity it answers for; no cube ever receives it.
      state: capture === undefined ? undefined : rowStateFor(c.name, c.manifest.tables, capture),
    }
  })

  const RegistryLive = registryFrom(entries, system.liveLinks, system.isEnabled, system.entityPermissions)

  // Layers contributed by cubes. In practice: `AuthorizationLive` from the auth cube. With auth
  // unmounted the list is empty -- and then no cube asks for the tag either, because `checkCubes`
  // would already have stopped startup.
  //
  // They get the registry too: the auth cube reads user data the same way any cube would --
  // through the registry, never by opening the account cube's database.
  //
  // Cube layers are typed `Layer<Provided, unknown, Registry>`: the exact union of services is
  // unknowable to TypeScript with runtime discovery kept, and the ERROR channel is `unknown`.
  // `mergeAll` needs a known error channel, so the erasure that used to sit here was an
  // `as unknown as` cast. It is gone (QWB-38): `Layer.orDie` closes the error channel
  // honestly -- a cube layer that fails at build SHOULD kill startup, exactly like every other
  // mount-time refusal -- and the provided side is then `never`, which `mergeAll` accepts
  // directly. No cast remains in this composition.
  const CubeLayers = system.cubes
    .map((c) => c.parts.layers)
    .filter((l): l is Layer.Layer<never, unknown, Registry> => l !== undefined)
    .map((l) => l.pipe(Layer.provide(RegistryLive), Layer.orDie))

  // The handlers read the mount's custom-field definitions per request (custom-fold.ts).
  const HandlersLive = buildHandlers(api, system.cubes).pipe(
    Layer.provide(Layer.merge(RegistryLive, Layer.succeed(CustomFields, system.customFields))),
  )

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
          return yield* Effect.catchAll(
            Effect.zipRight(attempt, HttpServerResponse.json(spec).pipe(Effect.orDie)),
            () => Effect.succeed(HttpServerResponse.empty({ status: 401 })),
          )
        }),
      )
    }),
  )

  return HttpApiBuilder.serve((app) =>
    // logRefusals sits outside the disabled-cube filter so it sees every final status.
    HttpMiddleware.logger(
      logRefusals(
        rejectDisabled(
          system.cubes,
          system.isEnabled,
        )(
          // Dev-only, opt-in via QWBE_TRACE_URL: echo the request span's trace id, so a slow
          // request in the browser maps to its waterfall in Jaeger. Off means no header.
          traceUrl === undefined ? app : traceIdHeader(app),
        ),
      ),
    ),
  ).pipe(
    // Browser origins come from QWBE_ALLOWED_ORIGINS. Unset means ["*"], no restriction, so
    // local development needs no configuration. With the variable
    // set, unlisted origins get no access-control-allow-origin header and the browser blocks
    // them. Note: this is CORS, a browser enforcement only -- it is NOT authentication, and
    // non-browser clients never send an Origin at all. The matcher (array vs predicate) is
    // chosen in origins.ts.
    Layer.provide(
      HttpApiBuilder.middlewareCors({
        allowedOrigins: corsOriginMatcher(allowedOrigins),
        allowedHeaders: ["Content-Type", "Authorization"],
        allowedMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      }),
    ),
    // The spec route needs the auth cube's Authorization service. Every system that can pass
    // the life rules has it (with no cube layer providing Authorization, mount refuses to
    // start), but TypeScript cannot know the merged cube layers provide it -- what a cube
    // layer provides is kept opaque to the kernel. This cast is now the one erasure left in
    // main.ts.
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
    Layer.provide(NodeHttpServer.layer(() => createServer(), { port })),
    // Tracer for the whole serving stack when QWBE_TRACE_URL is set (no-op otherwise);
    // needs QwbeConfig, which launch provides below.
    Layer.provide(TracingLive),
  )
})

// --- 6. the edge: the one place a boot failure becomes an exit code ---
//
// A refusal before or during the mount (origins, discovery, storage, a migration, the mount)
// exits 2; a broken life rule, an unreadable or tampered ledger, invalid config and anything
// unforeseen exit 1 -- the codes the boot has always used. The operator reads the refusal's
// own message on stderr, as before.
const exitCodeOf = (error: unknown): number =>
  Predicate.isTagged(error, "BootRefused") || Predicate.isTagged(error, "OriginsRefused") ? 2 : 1

NodeRuntime.runMain(
  boot.pipe(
    Effect.flatMap(Layer.launch),
    Effect.provide(QwbeConfigLive),
    Effect.provide(NodeContext.layer),
    Effect.tapErrorCause((cause) =>
      Option.match(Cause.failureOption(cause), {
        onSome: (error) => Console.error(`\n${error.message}\n`),
        onNone: () => (Cause.isInterruptedOnly(cause) ? Effect.void : Effect.logError(cause)),
      }),
    ),
  ),
  {
    disableErrorReporting: true,
    teardown: (exit, onExit) =>
      onExit(
        Exit.isSuccess(exit) || Cause.isInterruptedOnly(exit.cause)
          ? 0
          : Option.match(Cause.failureOption(exit.cause), { onSome: exitCodeOf, onNone: () => 1 }),
      ),
  },
)
