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

import { Effect } from "effect"
import { busFrom } from "./bus.ts"
import { installerFor } from "./install.ts"
import { discover } from "./scan.ts"

export { BrokenCubeError, DoubleCapabilityError, DoublePrivilegeError, DuplicateCubeError } from "./errors-discovery.ts"

import { BrokenCubeError, DoubleCapabilityError, DoublePrivilegeError } from "./errors-discovery.ts"
import {
  type Catalogue,
  type CommandInfo,
  type CommandRunner,
  type CommandSpec,
  type CredentialVerifier,
  type CubeDefinition,
  type CubeParts,
  fullName,
  type Manifest,
  type Subscription,
  validateCommands,
  validateManifest,
} from "./manifest.ts"
import { migrateDataFiles } from "./migrate.ts"
import { activeLinks, type SpaceDefinition } from "./space.ts"
import { type Switches, switchesFrom } from "./state.ts"
import { checkUniqueTables, storeFor } from "./store.ts"

export type MountedCube = {
  readonly manifest: Manifest
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

  const out: Array<{ name: string; plugin: string | null; definition: CubeDefinition }> = []
  for (const entry of onDisk.filter((c) => requested.includes(c.name))) {
    let mod: Record<string, unknown>
    try {
      mod = (await import(entry.specifier)) as Record<string, unknown>
    } catch (e) {
      throw new BrokenCubeError(entry.name, (e as Error).message)
    }
    const definition = mod.cube as CubeDefinition | undefined
    if (!definition) throw new BrokenCubeError(entry.name, "index.ts does not export `cube`")
    if (!definition.manifest) throw new BrokenCubeError(entry.name, "definition has no `manifest`")
    if (typeof definition.create !== "function") throw new BrokenCubeError(entry.name, "definition has no `create`")

    // The manifest is checked against the DIRECTORY it came from, not against what it says
    // about itself. A cube cannot lie about who it is. For a child the layout check extends
    // to the parent: `booktags/bookmarks` must declare `parent: "booktags"` and sit in the
    // `booktags` directory -- both halves come from disk, never from the manifest alone.
    const leaf = entry.name.includes("/") ? entry.name.split("/")[1] : entry.name
    const declaredParent = entry.name.includes("/") ? entry.name.split("/")[0] : undefined
    validateManifest(leaf as string, definition.manifest)
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

export type MountedSystem = {
  readonly cubes: ReadonlyArray<MountedCube>
  readonly switches: Switches
  readonly bus: ReturnType<typeof busFrom>
  readonly permissions: ReadonlyMap<string, ReadonlyArray<string>>
  readonly commands: () => ReadonlyArray<CommandInfo>
  readonly catalogue: () => Catalogue
  readonly liveLinks: () => ReadonlyArray<import("./space.ts").Link>
  /** Parent-masked enablement: a child is off while its parent is off. Use this at the edge. */
  readonly isEnabled: (cube: string) => boolean
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
): MountedSystem => {
  migrateDataFiles()
  const manifests = definitions.map((d) => d.definition.manifest)

  checkUniqueTables(manifests.map((m) => ({ name: fullName(m), tables: m.tables })))

  const privileged = manifests.filter((m) => m.managesCubes).map((m) => fullName(m))
  if (privileged.length > 1) throw new DoublePrivilegeError(privileged)

  // Credential verification is a declared capability with exactly one provider and one
  // consumer. Both are named in manifests, so `grep -r providesCredentials` shows the whole
  // arrangement -- the same visibility rule as `managesCubes`.
  const providers = manifests.filter((m) => m.providesCredentials).map((m) => fullName(m))
  if (providers.length > 1) throw new DoubleCapabilityError("providesCredentials", providers)
  const consumers = manifests.filter((m) => m.usesCredentials).map((m) => fullName(m))
  if (consumers.length > 1) throw new DoubleCapabilityError("usesCredentials", consumers)
  const runners = manifests.filter((m) => m.runsCommands).map((m) => fullName(m))
  if (runners.length > 1) throw new DoubleCapabilityError("runsCommands", runners)
  // The provider fills this during its own `create`; the consumer receives a wrapper that reads
  // it at call time. Late binding on purpose -- otherwise the two cubes would have to be created
  // in a particular order, and mount order is just the order of directory names on disk.
  const verifierHolder: { current?: CredentialVerifier } = {}
  const lateBoundVerifier: CredentialVerifier = {
    verify: (username, password) =>
      verifierHolder.current ? verifierHolder.current.verify(username, password) : Effect.succeed(undefined),
  }

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
    definitions.map(({ name, plugin, definition }) => {
      const m = definition.manifest
      const parts = cubes.find((c) => c.name === name)?.parts
      const endpoints = (parts?.group as { endpoints?: Record<string, { path?: string }> } | undefined)?.endpoints
      const firstPath = Object.values(endpoints ?? {})[0]?.path
      return {
        name,
        parent: m.parent,
        entity: m.entity,
        screen: m.screen === true,
        enabled: isEnabled(name),
        required: m.required === true,
        system: plugin === null,
        plugin,
        prefix: firstPath?.split("/").filter(Boolean)[0],
        publishes: m.publishes ?? [],
        sortable: m.sortable ?? [],
        links: liveLinks()
          .filter((l) => l.from === name)
          .map((l) => ({ to: l.to, field: l.field, label: l.label })),
      }
    })

  const cubes: Array<MountedCube> = definitions.map(({ plugin, definition }) => {
    const m = definition.manifest
    const full = fullName(m)
    const parts = definition.create({
      store: storeFor(full, m.tables, m.sortable ?? []),
      bus: bus.for(full),
      catalogue,
      permissions: () => permissions,
      commands,
      switches: m.managesCubes ? { list: switches.list, set: switches.set } : undefined,
      // The same declared basis as the switches: writing to the cubes directory is a privilege,
      // and it goes to the one cube that asked for `managesCubes` in the open.
      installer: m.managesCubes ? installerFor() : undefined,
      credentials: m.usesCredentials ? lateBoundVerifier : undefined,
      runCommands: m.runsCommands ? runner : undefined,
    })
    if (m.providesCredentials) {
      if (!parts.credentials) {
        throw new BrokenCubeError(full, "declares `providesCredentials: true` but returned no `credentials`")
      }
      verifierHolder.current = parts.credentials
    }
    for (const s of parts.subscriptions ?? []) subscriptions.push({ cube: full, subscription: s })

    // Commands come from `create`, so they are validated here rather than in the manifest pass.
    const own = parts.commands ?? []
    validateCommands(m, own)
    allCommands.push(...own)

    return { manifest: m, name: full, parts, plugin, commands: own }
  })

  // Every cube is created and every subscription registered -- publishing is now safe.
  bus.seal()

  return { cubes, switches, bus, permissions, commands, catalogue, liveLinks, isEnabled }
}
