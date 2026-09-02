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

import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Effect } from "effect"
import { capabilityRuntime } from "../capability-runtime.ts"
import { buildCatalogue } from "../catalogue.ts"
import { type CubeDefinition, decodeCubeExport, validateCubeParts } from "../cube-contract.ts"
import { assertPackageContracts } from "../package-contract.ts"
import { busFrom } from "./bus.ts"
import { installerFor } from "./install.ts"

import { discover } from "./scan.ts"

export { BrokenCubeError, DoubleCapabilityError, DoublePrivilegeError, DuplicateCubeError } from "./errors-discovery.ts"

import type { Subscription } from "../catalogue.ts"
import { BrokenCubeError, DoubleCapabilityError, DoublePrivilegeError } from "./errors-discovery.ts"
import type { Catalogue, CommandInfo, CommandRunner, CommandSpec, CubeParts } from "./manifest.ts"
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
import { checkUniqueTables, customFieldToolsFor, storeFor } from "./store.ts"

export type MountedCube = {
  readonly manifest: import("../cube-contract.ts").CubeManifest
  /** Full identity: `<parent>/<name>` for a child, bare name otherwise. */
  readonly name: string
  readonly parts: CubeParts
  /** Which plugin brought it, or `null` for the ones shipped with core. */
  readonly plugin: string | null
  readonly commands: ReadonlyArray<CommandSpec>
}

/**
 * Load the definitions.
 *
 * `QWBE_MOUNTED` narrows the list so decoupling can be exercised without touching code or
 * deleting files. A requested name with no directory is an error -- otherwise a typo would look
 * exactly like a missing cube and cost an hour.
 */
export const loadDefinitions = async (): Promise<
  ReadonlyArray<{ name: string; plugin: string | null; definition: CubeDefinition }>
> => {
  const onDisk = discover()

  const requested = process.env.QWBE_MOUNTED
    ? process.env.QWBE_MOUNTED.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : onDisk.map((c) => c.name)

  const missing = requested.filter((n) => !onDisk.some((c) => c.name === n))
  if (missing.length > 0) {
    throw new Error(
      `QWBE_MOUNTED names cubes that are not on disk: ${missing.join(", ")}. ` +
        `Found: [${onDisk.map((c) => c.name).join(", ")}].`,
    )
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
  // The package contract, enforced by the kernel rather than by the pack (QWB-54). Runs before
  // the first plugin import below, so a package that breaks it never executes.
  await assertPackageContracts(mounting)

  const out: Array<{ name: string; plugin: string | null; definition: CubeDefinition }> = []
  for (const entry of mounting) {
    let mod: unknown
    try {
      // The specifier is resolved HERE, against this module's own directory, and imported as a
      // file URL. Two reasons, one per shape of the kernel. In a checkout nothing changes: the
      // specifier is relative and lands on the same file the bare import reached. In the
      // compiled kernel the TypeScript emit wraps relative dynamic imports in a helper that
      // rewrites a trailing .ts to .js at runtime -- which would miss every pack cube, because
      // a pack ships TypeScript sources and is never compiled. A file URL pins the exact file
      // and is left untouched by that rewrite, so dist/index.js loads for core cubes and the
      // pack's own index.ts loads (type-stripped, outside node_modules) for plugins.
      mod = await import(pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), entry.specifier)).href)
    } catch (e) {
      throw new BrokenCubeError(entry.name, e instanceof Error ? e.message : String(e))
    }
    const definition = decodeCubeExport(mod, entry.name)

    // The manifest is checked against the DIRECTORY it came from, not against what it says
    // about itself. A cube cannot lie about who it is. For a child the layout check extends
    // to the parent: `booktags/bookmarks` must declare `parent: "booktags"` and sit in the
    // `booktags` directory -- both halves come from disk, never from the manifest alone.
    const leaf = leafOf(entry.name)
    const declaredParent = parentOf(entry.name)
    validateManifest(leaf, definition.manifest)
    const m = definition.manifest
    if (m.parent !== declaredParent) {
      throw new BrokenCubeError(
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
}

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
export const mount = (
  definitions: ReadonlyArray<{ name: string; plugin: string | null; definition: CubeDefinition }>,
  spaces: ReadonlyArray<SpaceDefinition>,
  // QWB-44: storage boot (Postgres init plus declared data migrations) moved to main.ts via
  // bootStorage, and the ledger parameter mount used to swallow with `void ledger` is gone
  // with it -- the only remaining caller is main.ts, AFTER bootStorage succeeded. Mounting
  // against an unmigrated database is therefore unreachable from this module.
): MountedSystem => {
  const manifests = definitions.map((d) => d.definition.manifest)

  checkUniqueTables(manifests.map((m) => ({ name: fullName(m), tables: m.tables })))

  const privileged = manifests.filter((m) => m.managesCubes).map((m) => fullName(m))
  if (privileged.length > 1) throw new DoublePrivilegeError(privileged)

  // Credential verification is a declared capability with exactly one provider and one
  // consumer. Both are named in manifests, so `grep -r providesCredentials` shows the whole
  // arrangement -- the same visibility rule as `managesCubes`.
  const runners = manifests.filter((m) => m.runsCommands).map((m) => fullName(m))
  if (runners.length > 1) throw new DoubleCapabilityError("runsCommands", runners)
  // The same single-holder rule for `providesCustomFields`: the flag hands out an unrestricted
  // reader over every other cube's rows under that cube's own DB role. Two holders would mean
  // two plugins reading each other's data with no permission gate between them.
  const fieldReaders = manifests.filter((m) => m.providesCustomFields).map((m) => fullName(m))
  if (fieldReaders.length > 1) throw new DoublePrivilegeError(fieldReaders)
  // The provider fills this during its own `create`; the consumer receives a wrapper that reads
  // it at call time. Late binding on purpose -- otherwise the two cubes would have to be created
  // in a particular order, and mount order is just the order of directory names on disk.
  const capabilities = capabilityRuntime(manifests)

  const switches = switchesFrom(manifests.map((m) => ({ name: fullName(m), required: m.required === true })))

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
        if (!command) return yield* Effect.fail({ _tag: "UnknownCommand" as const })

        // The check lives HERE, with the dispatcher -- not in whoever calls it. That is the whole
        // point of moving it: before, the permission was checked in the CLI gate while `run` was
        // handed to every cube, so any cube could skip the gate entirely.
        if (!callerPermissions.includes(command.permission)) {
          return yield* Effect.fail({ _tag: "NotAllowed" as const, permission: command.permission })
        }

        const allowed = command.maxArgs ?? 0
        if (args.length > allowed) {
          return yield* Effect.fail({ _tag: "TooManyArgs" as const, allowed, got: args.length })
        }

        // Permisiunile apelantului se dau comenzii, nu se lasă s-o ceară ea din context. Vezi
        // `CommandSpec.run` în `manifest.ts` pentru de ce e asta granița.
        const result = yield* command.run(args, callerPermissions).pipe(
          Effect.map((output) => ({ output, ok: true })),
          Effect.catchAll((message) => Effect.succeed({ output: String(message), ok: false })),
        )
        return { command: name, output: result.output, ok: result.ok }
      }),
  }

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
    )

  const cubes: Array<MountedCube> = definitions.map(({ plugin, definition }) => {
    const m = definition.manifest
    const full = fullName(m)
    const created = definition.create({
      // The batch capability is a declared privilege (`usesBatch`): a cube that did not ask
      // gets the six-operation store only. See manifest.ts for why it is declared, not assumed.
      store: storeFor(full, m.tables, m.sortable ?? [], m.usesBatch === true),
      bus: bus.for(full, m.publishes),
      catalogue,
      permissions: () => permissions,
      commands,
      switches: m.managesCubes ? { list: switches.list, set: switches.set } : undefined,
      // The same declared basis as the switches: writing to the cubes directory is a privilege,
      // and it goes to the one cube that asked for `managesCubes` in the open.
      installer: m.managesCubes ? installerFor() : undefined,
      credentials: m.usesCredentials ? capabilities.credentials : undefined,
      identities: m.usesIdentityDirectory ? capabilities.identities : undefined,
      entityPermissions: m.usesEntityPermissions ? capabilities.permissions : undefined,
      runCommands: m.runsCommands ? runner : undefined,
      customFields: m.providesCustomFields
        ? customFieldToolsFor((name) => cubes.find((c) => c.name === name))
        : undefined,
    })
    const parts = capabilities.mediate(full, m, created)
    validateCubeParts(full, parts)
    validateAgentSurface(full, m, parts.group)
    if (m.providesCredentials) {
      if (!parts.credentials) {
        throw new BrokenCubeError(full, "declares credentials but returned none")
      }
      capabilities.holders.verifier.current = parts.credentials
    }
    if (m.providesIdentityDirectory) {
      if (!parts.identities) throw new BrokenCubeError(full, "declares identity directory but returned none")
      capabilities.holders.identity.current = parts.identities
    }
    if (m.providesEntityPermissions) {
      if (!parts.entityPermissions) {
        throw new BrokenCubeError(full, "declares entity permissions but returned none")
      }
      capabilities.holders.permission.current = parts.entityPermissions
    }
    for (const s of parts.subscriptions ?? []) subscriptions.push({ cube: full, subscription: s })

    // Commands come from `create`, so they are validated here rather than in the manifest pass.
    const own = parts.commands ?? []
    validateCommands(m, own)
    allCommands.push(...own)
    // Route permissions, like commands: the declaration may not name a route that does not
    // exist nor a permission the cube does not declare. Run here so the gate covers every
    // mounted cube -- a pack's included, since this is the pass a pack is mounted through.
    validateRoutes(m, parts.group)

    return { manifest: m, name: full, parts, plugin, commands: own }
  })

  // Every cube is created and every subscription registered -- publishing is now safe.
  bus.seal()

  // A re-enabled cube may have missed events published while it was off. The kernel announces
  // the re-enablement on the bus; any cube whose events matter to a sibling subscribes and
  // replays its CURRENT values. The kernel publishes the fact, never the payload -- it knows
  // nothing about what a setting contains.
  switches._wireOnEnable((cube) => bus.for("qwbe").publish("qwbe/cube.enabled", { cube }))

  return {
    cubes,
    switches,
    bus,
    permissions,
    commands,
    catalogue,
    liveLinks,
    isEnabled,
    entityPermissions: capabilities.permissions,
  }
}
