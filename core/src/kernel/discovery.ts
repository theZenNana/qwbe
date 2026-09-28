// DISCOVERY -- level 0, and the reason this prototype exists.
//
// There is no list of cubes anywhere. The kernel reads two places and merges them into ONE
// flat namespace:
//
//     src/cubes/<name>/              cubes that ship with core (auth, account, settings, cli…)
//     plugins/<plugin>/cubes/<name>/ cubes brought by an installed plugin
//
// A plugin cube is not second class. It lands in the same namespace, gets the same tools, and
// appears in the frontend the same way. Installing a plugin is copying a directory; there is
// nothing to register, and nothing existing to edit. That is the whole difference between a
// plugin system and a fork.
//
// Severity is deliberate: a broken manifest stops startup rather than being skipped. Skipping
// would mean starting with half the cubes and nobody noticing until production.

import { pathToFileURL } from "node:url"
import { type Context, Data, Effect } from "effect"
import { capabilityRuntime } from "../capability-runtime.ts"
import { buildCatalogue, metadataCache } from "../catalogue.ts"
import { QwbeConfig } from "../config.ts"
import { type CubeDefinition, decodeCubeExport, validateCubeParts } from "../cube-contract.ts"
import { type CustomFields, customFieldsRegistry } from "../custom-defs-reader.ts"
import { assertPackageContracts, checkPackageSource } from "../package-contract.ts"
import { busFrom } from "./bus.ts"
import { installerFor } from "./install.ts"

import { discover } from "./scan.ts"

export { BrokenCubeError, DoubleCapabilityError, DoublePrivilegeError, DuplicateCubeError } from "./errors-discovery.ts"

import type { Subscription } from "../catalogue.ts"
import { captureEntity } from "../entity-enforcement.ts"
import { BrokenCubeError, DoubleCapabilityError, DoublePrivilegeError } from "./errors-discovery.ts"
import type { Catalogue, CommandInfo, CommandRunner, CommandSpec, CubeParts, Manifest } from "./manifest.ts"
import { NotAllowed, TooManyArgs, UnknownCommand } from "./manifest.ts"
import {
  fullName,
  leafOf,
  parentOf,
  pathPrefix,
  validateAgentSurface,
  validateCommands,
  validateManifest,
  validateRoutes,
} from "./manifest-validation.ts"
import { activeLinks, type SpaceDefinition } from "./space.ts"
import { type Switches, switchesFrom } from "./state.ts"
import { activityToolsFor, checkUniqueTables, customFieldToolsFor, storeFor } from "./store.ts"

export type MountedCube = {
  readonly manifest: import("../cube-contract.ts").CubeManifest
  /** Full identity: `<parent>/<name>` for a child, bare name otherwise. */
  readonly name: string
  readonly parts: CubeParts
  /** Which plugin brought it, or `null` for the ones shipped with core. */
  readonly plugin: string | null
  readonly commands: ReadonlyArray<CommandSpec>
}

/** A QWBE_MOUNTED name with no directory: a typo must not look like a missing cube. */
export class MountedNotOnDisk extends Data.TaggedError("MountedNotOnDisk")<{ readonly message: string }> {}

/**
 * The kernel's synchronous checks throw their refusal (a tagged error); this puts it on the
 * error channel instead. A cube's `create` is synchronous cube code and may throw anything.
 */
export const refusal = <A>(check: () => A): Effect.Effect<A, Error> =>
  Effect.try({ try: check, catch: (e) => (e instanceof Error ? e : new Error(String(e))) })

/**
 * Load the definitions.
 *
 * `QWBE_MOUNTED` narrows the list so decoupling can be exercised without touching code or
 * deleting files. A requested name with no directory is an error -- otherwise a typo would look
 * exactly like a missing cube and cost an hour.
 */
export const loadDefinitions = Effect.gen(function* () {
  const onDisk = yield* discover

  const { mounted } = yield* QwbeConfig
  const requested = mounted
    ? mounted
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : onDisk.map((c) => c.name)

  const missing = requested.filter((n) => !onDisk.some((c) => c.name === n))
  if (missing.length > 0) {
    return yield* new MountedNotOnDisk({
      message:
        `QWBE_MOUNTED names cubes that are not on disk: ${missing.join(", ")}. ` +
        `Found: [${onDisk.map((c) => c.name).join(", ")}].`,
    })
  }

  // A child cannot be requested without its parent -- the mask would make it unreachable and
  // the state file could not even express it. The parent is included silently rather than
  // refused, because the request's INTENT is clear; a refusal would teach nothing.
  const expanded = new Set(requested)
  for (const name of requested) {
    const p = parentOf(name)
    if (p && !expanded.has(p)) expanded.add(p)
  }
  const mounting = onDisk.filter((c) => expanded.has(c.name))
  // The package contract, enforced by the kernel rather than by the pack. Runs before
  // the first plugin import below, so a package that breaks it never executes.
  yield* assertPackageContracts(mounting)

  const out: Array<{ name: string; plugin: string | null; definition: CubeDefinition }> = []
  for (const entry of mounting) {
    const mod = yield* Effect.tryPromise({
      try: () => import(pathToFileURL(entry.specifier).href) as Promise<unknown>,
      catch: (e) => new BrokenCubeError(entry.name, e instanceof Error ? e.message : String(e)),
    })
    const definition = yield* refusal(() => decodeCubeExport(mod, entry.name))

    // The manifest is checked against the DIRECTORY it came from, not against what it says
    // about itself. A cube cannot lie about who it is. For a child the layout check extends
    // to the parent: `booktags/bookmarks` must declare `parent: "booktags"` and sit in the
    // `booktags` directory -- both halves come from disk, never from the manifest alone.
    const leaf = leafOf(entry.name)
    const declaredParent = parentOf(entry.name)
    yield* refusal(() => validateManifest(leaf, definition.manifest))
    const m = definition.manifest
    if (m.parent !== declaredParent) {
      return yield* new BrokenCubeError(
        entry.name,
        m.parent
          ? `manifest declares parent "${m.parent}" but the directory sits at "${entry.name}" -- they must match`
          : `the directory is nested at "${entry.name}" but the manifest declares no \`parent\` -- ` +
              `a child must name its parent, exactly as it names itself`,
      )
    }
    out.push({ name: entry.name, plugin: entry.plugin, definition })
  }
  return out
})

type MountedSystem = {
  readonly cubes: ReadonlyArray<MountedCube>
  readonly switches: Switches
  readonly bus: ReturnType<typeof busFrom>
  readonly permissions: ReadonlyMap<string, ReadonlyArray<string>>
  readonly commands: () => ReadonlyArray<CommandInfo>
  readonly catalogue: () => Catalogue
  readonly liveLinks: () => ReadonlyArray<import("./space.ts").Link>
  /** Parent-masked enablement: a child is off while its parent is off. Use this at the edge. */
  readonly isEnabled: (cube: string) => boolean
  readonly entityPermissions: import("../permissions-contracts.ts").PermissionService
  /** The mount's custom-field definitions; `main.ts` provides them to the handlers. */
  readonly customFields: Context.Tag.Service<CustomFields>
  /** Derived metadata of every mounted cube, through the same cache the catalogue reads. */
  readonly metadata: () => ReadonlyArray<import("../metadata/schemas.ts").CubeMetadata>
}

/**
 * Mount the system. Order matters and each step depends on the one before:
 *
 *   1. unique tables      -- nobody can claim another's data
 *   2. one privileged     -- at most one cube administers the switches
 *   3. switches           -- built from mounted cubes, so you cannot disable what never started
 *   4. permissions        -- aggregated before step 6, because `auth` asks for them in `create`
 *   5. bus + subscription list -- the list is filled in step 6 and read per publish
 *   6. live parts         -- each cube gets ITS store, ITS bus, and the switches only if declared
 */
/**
 * ONE flag, at most ONE holder (mount-time gate). The flags listed in `SingleHolderFlag` hand
 * out a privilege over other cubes' data with no permission gate between holders, so a second
 * holder must refuse to mount -- `DoublePrivilegeError` names every holder. Exported for the
 * focused unit test; `mount` is the only production caller.
 */
export type SingleHolderFlag = "managesCubes" | "providesCustomFields" | "readsActivity"

export const singleHolderOf = (manifests: ReadonlyArray<Manifest>, flag: SingleHolderFlag): ReadonlyArray<string> => {
  const holders = manifests.filter((m) => m[flag]).map((m) => fullName(m))
  if (holders.length > 1) throw new DoublePrivilegeError(holders)
  return holders
}

/** The switches for these definitions, read from disk once before `mount`. */
export const switchesFor = (definitions: ReadonlyArray<{ definition: CubeDefinition }>) =>
  switchesFrom(
    definitions.map(({ definition: { manifest: m } }) => ({ name: fullName(m), required: m.required === true })),
  )

export const mount = (
  definitions: ReadonlyArray<{ name: string; plugin: string | null; definition: CubeDefinition }>,
  spaces: ReadonlyArray<SpaceDefinition>,
  switches: Switches,
  // Storage boot (Postgres init plus declared data migrations) happens in main.ts via
  // bootStorage; the only remaining caller of mount is main.ts, AFTER bootStorage succeeded.
  // Mounting against an unmigrated database is therefore unreachable from this module.
) =>
  Effect.gen(function* () {
    const config = yield* QwbeConfig
    const manifests = definitions.map((d) => d.definition.manifest)

    yield* refusal(() => checkUniqueTables(manifests.map((m) => ({ name: fullName(m), tables: m.tables }))))

    // Credential verification is a declared capability with exactly one provider and one
    // consumer. Both are named in manifests, so `grep -r providesCredentials` shows the whole
    // arrangement -- the same visibility rule as `managesCubes`.
    const runners = manifests.filter((m) => m.runsCommands).map((m) => fullName(m))
    if (runners.length > 1) return yield* new DoubleCapabilityError("runsCommands", runners)
    // The single-holder privileges: each flag below hands out a privilege over OTHER cubes'
    // data with no permission gate between holders (managesCubes: cube registry;
    // providesCustomFields: unrestricted row reader under the holder's own DB role;
    // readsActivity (Echo A1): SELECT on the whole activity log -- every entity cube's
    // history). Two holders would read each other's users' data with no gate between them.
    yield* refusal(() => {
      singleHolderOf(manifests, "managesCubes")
      singleHolderOf(manifests, "providesCustomFields")
      singleHolderOf(manifests, "readsActivity")
    })
    // The provider is bound during its own `create`; the consumer receives a wrapper that reads
    // it at call time. Late binding on purpose -- otherwise the two cubes would have to be
    // created in a particular order, and mount order is just the order of directory names on disk.
    const capabilities = yield* capabilityRuntime(manifests)

    // A child lives under its parent's switch: disabling `booktags` disables everything below
    // it, and the state file cannot express "child on, parent off" -- the mask is applied at
    // read time, so there is no such state to represent. A child may still be switched off
    // alone; its own entry persists and takes effect the moment the parent comes back on.
    const isEnabled = (cube: string): boolean => {
      if (!switches.isEnabled(cube)) return false
      const slash = cube.indexOf("/")
      return slash === -1 || switches.isEnabled(cube.slice(0, slash))
    }

    const permissions = new Map<string, ReadonlyArray<string>>()
    for (const m of manifests) {
      for (const p of m.permissions ?? []) permissions.set(p.name, p.roles)
    }

    const subscriptions: Array<{ cube: string; subscription: Subscription }> = []
    const bus = busFrom(subscriptions, isEnabled)

    const liveLinks = () =>
      activeLinks(
        spaces,
        manifests.map((m) => ({ name: fullName(m), entity: m.entity })),
        isEnabled,
      )

    // Functions, not values: switch state changes at runtime and the frontend draws its tabs
    // from these, so they must see the state of NOW.
    // The full specs, INCLUDING `run`, never leave this closure. Cubes see metadata; only the
    // dispatcher below can execute, and only after checking the caller's permissions.
    const allCommands: Array<CommandSpec> = []
    const liveSpecs = () => allCommands.filter((c) => isEnabled(c.name.split(":")[0] as string))

    const commands = (): ReadonlyArray<CommandInfo> =>
      liveSpecs().map((c) => ({
        name: c.name,
        summary: c.summary,
        permission: c.permission,
        maxArgs: c.maxArgs ?? 0,
      }))

    const runner: CommandRunner = {
      invoke: (name, args, callerPermissions) =>
        Effect.gen(function* () {
          // A Map, so a name from Object.prototype cannot resolve to something inherited.
          const table = new Map(liveSpecs().map((c) => [c.name, c]))
          const command = table.get(name)
          if (!command) return yield* Effect.fail(new UnknownCommand())

          // The check lives HERE, with the dispatcher -- not in whoever calls it. That is the whole
          // point of moving it: before, the permission was checked in the CLI gate while `run` was
          // handed to every cube, so any cube could skip the gate entirely.
          if (!callerPermissions.includes(command.permission)) {
            return yield* Effect.fail(new NotAllowed({ permission: command.permission }))
          }

          const allowed = command.maxArgs ?? 0
          if (args.length > allowed) {
            return yield* Effect.fail(new TooManyArgs({ allowed, got: args.length }))
          }

          // The caller's permissions are handed to the command; it is not left to ask the context
          // for them. See `CommandSpec.run` in `manifest.ts` for why this is the boundary.
          const result = yield* command.run(args, callerPermissions).pipe(
            Effect.map((output) => ({ output, ok: true })),
            Effect.catchAll((message) => Effect.succeed({ output: String(message), ok: false })),
          )
          return { command: name, output: result.output, ok: result.ok }
        }),
    }

    // Filled below, one cube at a time; the closures read it at call time.
    const cubes: Array<MountedCube> = []
    const customFields = customFieldsRegistry()
    const cache = metadataCache()

    const catalogue = (): Catalogue =>
      buildCatalogue(
        definitions.map(({ name, plugin, definition }) => ({
          name,
          plugin,
          manifest: definition.manifest,
          cube: cubes.find((cube) => cube.name === name),
        })),
        isEnabled,
        pathPrefix,
        liveLinks(),
        { cache, activeCustomFields: customFields.service.active },
      )

    for (const { plugin, definition } of definitions) {
      const m = definition.manifest
      const full = fullName(m)
      const created = yield* refusal(() =>
        definition.create({
          // The batch capability is a declared privilege (`usesBatch`): a cube that did not ask
          // gets the six-operation store only. See manifest.ts for why it is declared, not assumed.
          // The activity capture entity reuses the mediation predicate, so what is recorded and
          // what is mediated can never disagree (entity-enforcement.ts).
          store: storeFor(full, m.tables, m.sortable ?? [], m.usesBatch === true, captureEntity(m), m.indexed ?? {}),
          bus: bus.for(full, m.publishes),
          catalogue,
          permissions: () => permissions,
          commands,
          switches: m.managesCubes ? { list: switches.list, set: switches.set } : undefined,
          // The same declared basis as the switches: writing to the cubes directory is a privilege,
          // and it goes to the one cube that asked for `managesCubes` in the open.
          installer: m.managesCubes ? installerFor(checkPackageSource, config) : undefined,
          credentials: m.usesCredentials ? capabilities.credentials : undefined,
          identities: m.usesIdentityDirectory ? capabilities.identities : undefined,
          entityPermissions: m.usesEntityPermissions ? capabilities.permissions : undefined,
          runCommands: m.runsCommands ? runner : undefined,
          customFields: m.providesCustomFields
            ? customFieldToolsFor((name) => cubes.find((c) => c.name === name), customFields)
            : undefined,
          activity: m.readsActivity ? activityToolsFor(full) : undefined,
        }),
      )
      const parts = capabilities.mediate(full, m, created)
      yield* refusal(() => {
        validateCubeParts(full, parts)
        validateAgentSurface(full, m, parts.group)
      })
      if (m.providesCredentials) {
        if (!parts.credentials) return yield* new BrokenCubeError(full, "declares credentials but returned none")
        yield* capabilities.bind.verifier(parts.credentials)
      }
      if (m.providesIdentityDirectory) {
        if (!parts.identities) return yield* new BrokenCubeError(full, "declares identity directory but returned none")
        yield* capabilities.bind.identity(parts.identities)
      }
      if (m.providesEntityPermissions) {
        if (!parts.entityPermissions) {
          return yield* new BrokenCubeError(full, "declares entity permissions but returned none")
        }
        yield* capabilities.bind.permission(parts.entityPermissions)
      }
      for (const s of parts.subscriptions ?? []) subscriptions.push({ cube: full, subscription: s })

      // Commands come from `create`, so they are validated here rather than in the manifest pass.
      const own = parts.commands ?? []
      // Route permissions, like commands: the declaration may not name a route that does not
      // exist nor a permission the cube does not declare. Run here so the gate covers every
      // mounted cube -- a pack's included, since this is the pass a pack is mounted through.
      yield* refusal(() => {
        validateCommands(m, own)
        validateRoutes(m, parts.group)
      })
      allCommands.push(...own)

      cubes.push({ manifest: m, name: full, parts, plugin, commands: own })
    }

    // Every cube is created and every subscription registered -- publishing is now safe.
    bus.seal()

    // A re-enabled cube may have missed events published while it was off. The kernel announces
    // the re-enablement on the bus; any cube whose events matter to a sibling subscribes and
    // replays its CURRENT values. The kernel publishes the fact, never the payload -- it knows
    // nothing about what a setting contains.
    switches._wireOnEnable((cube) => bus.for("qwbe").publish("qwbe/cube.enabled", { cube }))

    const system: MountedSystem = {
      cubes,
      switches,
      bus,
      permissions,
      commands,
      catalogue,
      liveLinks,
      isEnabled,
      entityPermissions: capabilities.permissions,
      customFields: customFields.service,
      metadata: () => cache.metadata(cubes, liveLinks(), isEnabled),
    }
    return system
  })
