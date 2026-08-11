// The manifest -- the only source of truth about a cube.
//
// The invariant everything else serves:
//
//     ONE CUBE = ONE DIRECTORY. INSTALLING IT TOUCHES NO EXISTING FILE.
//
// So a cube declares, about itself: its name, the tables it owns, the permissions it invents,
// the events it publishes, and the CLI commands it offers. The kernel AGGREGATES those at
// mount time (`discovery.ts`). There is no central list of cubes anywhere.
//
// What is NOT here, and this is the change from the previous iteration: a cube does not
// declare links to other entities. Those live one level up, in `spaces/` -- declared by a
// third party, so neither side knows the other exists. See `space.ts`.

import type { Effect } from "effect"
import type { SummaryRow } from "./entity.ts"
import type { Page, PageRequest } from "./pagination.ts"
import type { RequiredCubeError, StateFileError, UnknownCubeError } from "./state.ts"

/** A permission invented by a cube, with the roles that receive it by default. */
export type PermissionSpec = {
  /** e.g. "notes:read". The prefix must be the cube name -- checked at mount. */
  readonly name: string
  readonly roles: ReadonlyArray<string>
}

/**
 * A CLI command a cube offers.
 *
 * Commands are aggregated the same way permissions are, so the `cli` cube never needs to
 * know which cubes exist. Adding a command is adding a line to your own manifest.
 */
export type CommandSpec = {
  /** e.g. "notes:count". Prefix must be the cube name -- checked at mount. */
  readonly name: string
  readonly summary: string
  /** Permission required to run it. Must be one this cube declares. */
  readonly permission: string
  /**
   * How many arguments it accepts. Default zero.
   *
   * Found by attacking the gate's own claim: `notes:count && cat /etc/passwd` returned 200.
   * No shell ran -- that part held -- but the gate took the first token as the command and threw
   * the rest away in silence, so the caller believed the whole line had executed. Silent
   * discarding of input is the failure mode a gate exists to prevent, not produce.
   */
  readonly maxArgs?: number
  /**
   * Ce poate rula o comandă, și ce nu.
   *
   * `R` rămâne `never`: o comandă NU are voie să ceară nimic din context. Regula a fost pusă la
   * încercare de `cli:help`, care trebuie să arate fiecăruia doar comenzile pe care le poate
   * rula — altfel lista e un inventar de capabilități oferit tocmai cui nu le are. Avea nevoie
   * de `CurrentUser`, iar contractul îl interzicea.
   *
   * Erau două ieșiri, și sunt două răspunsuri diferite la „ce ESTE o comandă":
   *
   *   `R` se lărgește la `CurrentUser`  -> o comandă poate cere din context, deci orice comandă
   *                                        poate cere orice serviciu. Contractul se deschide.
   *   utilizatorul vine ca ARGUMENT     -> comanda rămâne o funcție pură, i se dă tot ce-i
   *                                        trebuie, iar cine i-l dă e dispecerul din kernel.
   *
   * Aleasă a doua, pe 9 aug 2026. Permisiunile apelantului sosesc ca parametru, verificate deja
   * de dispecer înainte de apel. O comandă vede CE poate cere apelantul, nu are de unde CERE.
   */
  readonly run: (
    args: ReadonlyArray<string>,
    callerPermissions: ReadonlyArray<string>,
  ) => Effect.Effect<string, string, never>
}

/**
 * What every cube may SEE about a command: metadata, never the function.
 *
 * The split exists because handing `run` around was a capability leak, demonstrated rather
 * than argued: a cube declaring no permissions at all took `commands()`, called `run()` on
 * `account:list`, and got the account table -- with no token, no session, and `dependency-cruiser`
 * reporting zero violations, because nothing forbidden had been imported. It used exactly what
 * the kernel handed it.
 *
 * That is what made this worse than the store hole: the store bypass is an illegal import and a
 * boundary rule catches it. This one was legal by construction. Of the four paths between cubes,
 * `commands` was the only one passing executable capability instead of mediated data -- so it was
 * brought in line with the other three.
 */
export type CommandInfo = {
  readonly name: string
  readonly summary: string
  readonly permission: string
  readonly maxArgs: number
}

export type CommandResult = {
  readonly command: string
  readonly output: string
  readonly ok: boolean
}

/** The dispatcher. Held by the kernel, given only to a cube declaring `runsCommands: true`. */
export type CommandRunner = {
  /** Runs a command AFTER checking its permission against the caller's own. */
  readonly invoke: (
    name: string,
    args: ReadonlyArray<string>,
    callerPermissions: ReadonlyArray<string>,
  ) => Effect.Effect<CommandResult, CommandRefusal, never>
}

export type CommandRefusal =
  | { readonly _tag: "UnknownCommand" }
  | { readonly _tag: "NotAllowed"; readonly permission: string }
  | { readonly _tag: "TooManyArgs"; readonly allowed: number; readonly got: number }

export type Manifest = {
  /** Must equal the directory name -- checked at mount, so two cubes cannot share a name. */
  readonly name: string
  /**
   * Declared by a CHILD cube: the name of the parent directory it sits in.
   *
   * Runtime hierarchy (docs/booktags-hierarchy.md): a child lives at
   * `cubes/<parent>/<child>/` or `plugins/<p>/cubes/<parent>/<child>/` and is addressed as
   * `<parent>/<child>`. The kernel checks this field against the real directory layout --
   * a manifest cannot claim a parent it does not sit inside, and a directory nested in a cube
   * without declaring it fails the same way. Absent for standalone cubes and for parents.
   */
  readonly parent?: string
  /** Tables it OWNS. Its store opens exactly these and nothing else (`store.ts`). */
  readonly tables: ReadonlyArray<string>
  /** The public entity it holds, e.g. "Account". Absent for cubes without data. */
  readonly entity?: string
  /**
   * "I have a screen of my own." Entity cubes get the generic list screen; this is for a cube
   * whose screen is not a list of rows -- one that owns no table, yet whose screen is the whole
   * point of it.
   *
   * Declared BY the cube, aggregated by the kernel, like everything else here. The alternative
   * was writing a cube's name into the shell's sidebar, which is exactly the invariant this
   * file exists to protect.
   */
  readonly screen?: boolean
  /**
   * Fields callers may sort by. Empty means "meta columns only" (`id`, `type`, `createdAt`).
   *
   * Anything not listed is ignored, and the default order is used. Without this list, sorting
   * could order rows by a column the cube never puts in its responses -- which leaks information
   * about values the caller cannot read. Published in the catalogue so clients know the set.
   */
  readonly sortable?: ReadonlyArray<string>
  /** Requires a valid token. With no `auth` cube mounted, such a cube does not start at all. */
  readonly requiresAuth: boolean
  readonly permissions?: ReadonlyArray<PermissionSpec>
  /** Events it publishes. Declared so the catalogue can show who shouts what. */
  readonly publishes?: ReadonlyArray<string>
  /** Cannot be switched off from Settings. */
  readonly required?: boolean
  /**
   * DECLARED PRIVILEGE: this cube receives the on/off switches.
   *
   * At most one cube may ask for it, checked at mount. It is the only escape hatch in the
   * system and it is declared here, in the open -- `grep -r managesCubes cubes/` returns the
   * complete list of privileged cubes. That is the difference from an exemption buried in a
   * config file: exemptions there accumulate, this one is singular and visible.
   */
  readonly managesCubes?: boolean
  /**
   * DECLARED CAPABILITY: this cube can verify credentials. At most one may.
   *
   * Added after both reviewers found the same critical hole from different directions. The
   * `account` cube used to put `passwordHash` into its registry summary so that `auth` could
   * check a password. But a summary is a PUBLIC representation -- anything with `links:read`
   * could ask for it, and `reader` has that. Reproduced: an ordinary reader account fetched
   * `/links/Note/<id>` and read the administrator's hash out of `parents[0].summary.details`.
   * With a fixed salt and no KDF, an offline dictionary attack on that is instant.
   *
   * The mistake was using one channel for two incompatible jobs: showing a row to anyone, and
   * proving a password. So verification became its own narrow capability, wired by the kernel
   * between exactly one provider and one consumer. The hash now never leaves the cube that
   * stores it.
   */
  readonly providesCredentials?: boolean
  /** DECLARED NEED: this cube receives the credential verifier. At most one may. */
  readonly usesCredentials?: boolean
  /**
   * DECLARED CAPABILITY: this cube receives the command dispatcher. At most one may.
   *
   * The dispatcher checks each command's permission against the caller's, so the check cannot
   * be skipped by whoever holds it. Before this existed, every cube could run every command.
   */
  readonly runsCommands?: boolean
  /**
   * Data-file migrations this package declares, run at mount before any store opens.
   *
   * Declared here -- in the declarative manifest, not in `create` -- because migration is a
   * package-level claim about where its data moved, not executable behaviour. The kernel
   * executes it after checking every entry against the mounted set and the package
   * provenance, so a plugin cannot ask for `auth.sqlite`.
   */
  readonly dataMigration?: ReadonlyArray<DataMigration>
}

/** What a credential provider offers, and a consumer receives. Never the hash itself. */
export type CredentialVerifier = {
  readonly verify: (
    username: string,
    password: string,
  ) => Effect.Effect<
    { readonly id: string; readonly username: string; readonly roles: ReadonlyArray<string> } | undefined,
    never,
    never
  >
}

export type SearchResult = {
  readonly rows: ReadonlyArray<SummaryRow>
  readonly total: number
}

/**
 * How a cube lets itself be found, without anyone importing it.
 *
 * Every function is `Effect<..., never, never>`: the kernel binds the cube's own store before
 * putting these in the registry, so callers supply nothing -- and, more importantly, cannot
 * slip in a different store.
 */
export type RelationalPart = {
  readonly search?: (field: string, value: string, page: PageRequest) => Effect.Effect<SearchResult, never, never>
  readonly summaryById?: (id: string) => Effect.Effect<SummaryRow | undefined, never, never>
  readonly fieldValue?: (id: string, field: string) => Effect.Effect<string | null, never, never>
}

/** A subscription to an event, by string name. See `bus.ts`. */
export type Subscription = {
  readonly event: string
  readonly handle: (payload: unknown) => Effect.Effect<void, never, never>
}

/**
 * What a cube's `index.ts` exports. A single export, named `cube`.
 *
 * `create` receives the cube's own tools and returns its live parts. It is a function, not an
 * object, precisely so a cube cannot close over a global store: there is none to reach.
 */
export type CubeDefinition = {
  readonly manifest: Manifest
  readonly create: (tools: CubeTools) => CubeParts
}

export type CubeTools = {
  readonly store: CubeStore
  readonly bus: CubeBus
  /** Names and shapes of mounted cubes -- never their data. The frontend draws screens from this. */
  readonly catalogue: () => Catalogue
  /** All permissions aggregated from every manifest. Read by `auth`. */
  readonly permissions: () => ReadonlyMap<string, ReadonlyArray<string>>
  /** Metadata for every command in the system. Deliberately WITHOUT `run` -- see `CommandInfo`. */
  readonly commands: () => ReadonlyArray<CommandInfo>
  // The five below are `?: X | undefined`, not `?: X`, and the difference is not decoration.
  // Under `exactOptionalPropertyTypes` a bare `?:` means "absent OR a value" -- never "present
  // and undefined". But the kernel BUILDS this object in one literal, writing
  // `installer: m.managesCubes ? installerFor() : undefined` for every cube; a cube that did not
  // ask gets the key with `undefined` in it. Same lie as `PageRequest.sortBy` and
  // `RegistryEntry.entity`, third place it turned up: the type refused what its only producer
  // actually produces.
  /** Present ONLY when the manifest asks for `runsCommands: true`. */
  readonly runCommands?: CommandRunner | undefined
  /** Present ONLY when the manifest asks for `managesCubes: true`. */
  readonly switches?: CubeSwitches | undefined
  /**
   * Present ONLY when the manifest asks for `managesCubes: true`.
   *
   * Copying a directory into `cubes/` is how a cube gets installed, and cubes may not touch
   * `node:fs`. So the kernel keeps the filesystem and lends a narrow, name-based capability --
   * see `install.ts` for what it deliberately cannot do.
   */
  readonly installer?: CubeInstaller | undefined
  /** Present ONLY when the manifest asks for `usesCredentials: true`, and only if some cube
   *  declares `providesCredentials`. */
  readonly credentials?: CredentialVerifier | undefined
}

export type Catalogue = ReadonlyArray<{
  readonly name: string
  /** The parent cube's name for a child (`booktags` for `booktags/bookmarks`), else absent. */
  readonly parent?: string | undefined
  /** `| undefined` for the same reason as in `CubeTools`: the kernel copies `m.entity` across
   *  for every cube, and a cube without an entity puts the key there holding `undefined`. */
  readonly entity?: string | undefined
  /** It has a screen of its own, without holding an entity. See `Manifest.screen`. */
  readonly screen: boolean
  readonly enabled: boolean
  readonly required: boolean
  readonly system: boolean
  /** Which plugin brought it, or `null` for the ones shipped with core. */
  readonly plugin: string | null
  /** First URL segment this cube serves under, when it has endpoints (children whose leaf
   *  name is taken serve under `<parent>-<name>`). Absent for cubes with no routes. */
  readonly prefix?: string | undefined
  readonly publishes: ReadonlyArray<string>
  /** Fields a caller may sort this cube's list by. Published so clients need not guess. */
  readonly sortable: ReadonlyArray<string>
  /** Links pointing OUT of this cube, resolved from the spaces. */
  readonly links: ReadonlyArray<{ readonly to: string; readonly field: string; readonly label: string }>
}>

/**
 * What a package in the store looks like from a cube's side: a name and what it brings.
 *
 * Never a path. The cube cannot express "install from /etc" because the type gives it nowhere
 * to put a path -- the narrowing is in the shape, not only in the validation.
 */
export type CubePackage = Readonly<{
  name: string
  kind: "cube" | "plugin"
  summary: string
  cubes: readonly string[]
  installed: boolean
  bytes: number
  conflicts: readonly string[]
}>

export type CubeInstaller = Readonly<{
  available: () => readonly CubePackage[]
  /** Disk state for exact discovery location; never exposes a path. */
  cubeOnDisk: (c: string, plugin: string | null) => boolean
  install: (name: string) => CubePackage
  /**
   * The administrative exception to "never a path": install from a directory an administrator
   * pointed at. The path is validated, the tree is copied into the store (symlinks and special
   * files refused, nothing executed from the source), and only then does the by-name install
   * run. Cubes still cannot express a path - only the kernel ever sees one, here.
   *
   * `staged` tells the caller whether the store copy was created by this call or an identical
   * one was already there (same fingerprint - idempotent reinstall).
   */
  stageAndInstall: (sourceDirectory: string) => CubePackage & { readonly staged: boolean }
  remove: (cube: string, plugin: string | null) => { readonly removed: string }
  /** Package name keeps rollback possible before its cubes exist in the mounted catalogue. */
  uninstallPackage: (name: string) => { readonly removed: string; readonly cubes: readonly string[] }
  /** Kernel owns process lifetime; settings receives only this narrow action. */
  restart: () => void
}>

export type CubeSwitches = {
  readonly list: () => ReadonlyArray<{
    readonly name: string
    readonly enabled: boolean
    readonly required: boolean
  }>
  /**
   * Fails instead of throwing: the cube sees in the type what a refusal can be -- a required
   * cube, an unknown one, a disk that would not take the write -- and maps each to its own
   * status. A `try/catch` around a string message could not tell them apart.
   */
  readonly set: (
    cube: string,
    enabled: boolean,
  ) => Effect.Effect<void, RequiredCubeError | UnknownCubeError | StateFileError>
}

export type CubeParts = {
  /** The cube's HttpApi contract (`HttpApiGroup`). */
  readonly group: unknown
  readonly handlers: Record<string, (input: never) => unknown>
  readonly relational?: RelationalPart
  readonly subscriptions?: ReadonlyArray<Subscription>
  /**
   * CLI commands this cube offers. Built in `create` because they need the cube's store.
   *
   * Aggregated by the kernel exactly like permissions, so the `cli` cube never learns which
   * cubes exist. Adding a command is adding a line to your own file.
   */
  readonly commands?: ReadonlyArray<CommandSpec>
  /** Provided ONLY by the cube declaring `providesCredentials: true`. */
  readonly credentials?: CredentialVerifier
  /**
   * Effect layers the cube provides to the whole system.
   *
   * Its only present use: the `auth` cube IMPLEMENTS the `Authorization` tag declared in the
   * kernel. General mechanism, not an auth special case -- but also the only way a cube can
   * affect what others see, so it gets read carefully at review.
   */
  readonly layers?: unknown
}

// --- manifest validation, run at mount ---

export class InvalidManifestError extends Error {
  constructor(directory: string, reasons: ReadonlyArray<string>) {
    super(
      `Invalid manifest in cube "${directory}":\n` +
        reasons.map((r) => `  - ${r}`).join("\n") +
        `\nThe cube does not mount. Fix the manifest in that cube's index.ts.`,
    )
    this.name = "InvalidManifestError"
  }
}

/**
 * Check a manifest against the directory it came from.
 *
 * The rule being defended: a manifest cannot lie. The name must be the directory's, and
 * permissions and commands must carry its prefix -- otherwise a cube could grant itself
 * `account:write` without being `account`. Same test as everywhere in this kernel: read the
 * real artefact, not the declaration.
 */
/**
 * A cube name must be a plain lowercase slug.
 *
 * Not cosmetic. An adversarial review built a cube called `notes:evil`; because command names
 * are split on `:` to find their owning cube, its commands were routed to the switch belonging
 * to `notes` -- so switching `notes:evil` off left its commands running while Settings reported
 * it disabled. A button that lies is worse than no button.
 *
 * Restricting the character set removes the ambiguity at its source instead of patching every
 * place that parses a name.
 */
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * The full identity of a cube: `<parent>/<name>` for a child, bare `name` otherwise.
 *
 * Everything derived from the cube's name -- permission and command prefixes, the switch key,
 * the store file -- uses this, so a child can never invent a name that collides with a
 * standalone cube. See docs/booktags-hierarchy.md section 1.
 */
export const fullName = (m: Pick<Manifest, "name" | "parent">): string => (m.parent ? `${m.parent}/${m.name}` : m.name)

/** The store file is path-safe: `booktags/bookmarks` -> `booktags--bookmarks.sqlite`. */
export const storeFileName = (cube: string): string => `${cube.replace(/\//g, "--")}.sqlite`

/**
 * ONE identity -> ONE path, in every direction the kernel needs.
 *
 * The compound identity `<parent>/<child>` is a TYPE-level fact (`fullName`), but paths are
 * strings. These three functions are the only legal transformations between them -- a `split("/")`
 * or a `replace("/", "-")` anywhere else is a divergent reimplementation, and reviewers found
 * them drifting apart between kernel and web.
 *
 *   screenPath  -- the web route a cube's screen lives at: `/booktags/bookmarks`, `/notes`
 *   prefixOf    -- the first HTTP segment a cube serves under: `bookmarks`, `booktags-settings`
 */
export const screenPath = (name: string, parent?: string): string => (parent ? `/${parent}/${name}` : `/${name}`)
export const leafOf = (full: string): string => (full.includes("/") ? (full.split("/")[1] as string) : full)
export const parentOf = (full: string): string | undefined => (full.includes("/") ? full.split("/")[0] : undefined)

/** The first segment of an HTTP path -- the segment the on/off switch matches on. */
export const pathPrefix = (path: string): string | undefined => path.split("/").filter(Boolean)[0]

/** The dash form used for route prefixes: `booktags/settings` -> `booktags-settings`. */
export const dashForm = (full: string): string => full.replace("/", "-")

/**
 * A data-file migration, DECLARED by the package (parent manifest), executed by the kernel.
 *
 * The kernel knows nothing about `bookmarks` or `booktags` -- it renames `fromFile` to
 * `storeFileName(toCube)` and nothing else. `toCube` must resolve to a mounted cube of THIS
 * package, and `fromFile` must be exactly the file of a cube with the same package provenance.
 * Both rules are checked at mount (`validateManifest` + `mount`); a manifest cannot name a
 * path, and cannot reach outside its own package.
 */
export type DataMigration = {
  /**
   * The old file's cube identity as a bare name (e.g. `bookmarks` for `bookmarks.sqlite`).
   *
   * Guarded two ways at mount: it must NOT be the name of a currently-mounted cube of another
   * package (a mounted cube's file is LIVE, not legacy), and when `fromPlugin` is given it must
   * equal the destination's provenance -- so the claim "this file used to belong to my package"
   * is checked against the package, not trusted from the manifest.
   */
  readonly fromCube: string
  /** The cube identity the data belongs to now; MUST be mounted and in the same package. */
  readonly toCube: string
  /**
   * Optional: which package the old cube belonged to (`null` = core). When declared, the kernel
   * checks it against the destination's provenance -- a mismatch means the manifest is claiming
   * history that is not its own.
   */
  readonly fromPlugin?: string | null
}

export const validateManifest = (directory: string, m: Manifest): void => {
  const reasons: Array<string> = []
  const full = fullName(m)

  if (m.name !== directory) {
    reasons.push(`name is "${m.name}" but the directory is "${directory}" -- they must match`)
  }
  if (!NAME_PATTERN.test(m.name)) {
    reasons.push(
      `name "${m.name}" must match ${NAME_PATTERN} -- lowercase letters, digits and dashes. ` +
        `A ":" in particular would make its commands look like they belong to another cube.`,
    )
  }
  if (m.parent !== undefined && !NAME_PATTERN.test(m.parent)) {
    reasons.push(`parent "${m.parent}" must match ${NAME_PATTERN} -- the same slug rule as a cube name`)
  }
  if (m.tables.length === 0 && m.entity) {
    reasons.push(`declares entity "${m.entity}" but owns no tables`)
  }
  for (const p of m.permissions ?? []) {
    if (!p.name.startsWith(`${full}:`)) {
      reasons.push(`permission "${p.name}" does not start with "${full}:" -- a cube cannot grant another's`)
    }
  }
  if (reasons.length > 0) throw new InvalidManifestError(directory, reasons)
}

/** Commands are validated separately: they are built by `create`, so they exist later. */
export const validateCommands = (m: Manifest, commands: ReadonlyArray<CommandSpec>): void => {
  const reasons: Array<string> = []
  const full = fullName(m)
  const own = new Set((m.permissions ?? []).map((p) => p.name))

  // Duplicates used to pass: the gate looks a command up with `Array.find`, so the first
  // declaration won and the second vanished without a word. Tables and cube names were already
  // checked for duplicates; commands had been left out.
  const seen = new Set<string>()
  for (const c of commands) {
    if (seen.has(c.name)) {
      reasons.push(`command "${c.name}" is declared twice -- the second one would be silently ignored`)
    }
    seen.add(c.name)
  }

  for (const c of commands) {
    if (!c.name.startsWith(`${full}:`)) {
      reasons.push(`command "${c.name}" does not start with "${full}:"`)
    }
    if (!own.has(c.permission)) {
      reasons.push(`command "${c.name}" requires permission "${c.permission}", which this cube does not declare`)
    }
  }
  if (reasons.length > 0) throw new InvalidManifestError(full, reasons)
}

export type CubeStore = {
  readonly all: <A>(table: string) => Effect.Effect<ReadonlyArray<A>, never, never>
  /** Real SQL paging: LIMIT/OFFSET plus a COUNT, not a slice taken in memory. */
  readonly page: <A>(
    table: string,
    page: PageRequest,
    where?: { readonly field: string; readonly value: string },
  ) => Effect.Effect<Page<A>, never, never>
  readonly byId: <A>(table: string, id: string) => Effect.Effect<A | undefined, never, never>
  readonly insert: (
    table: string,
    entityType: string,
    prefix: string,
    values: Record<string, unknown>,
  ) => Effect.Effect<Record<string, unknown>, never, never>
  readonly update: (
    table: string,
    id: string,
    patch: Record<string, unknown>,
  ) => Effect.Effect<Record<string, unknown> | undefined, never, never>
  readonly count: (table: string) => Effect.Effect<number, never, never>
}

export type CubeBus = {
  readonly publish: (event: string, payload: unknown) => Effect.Effect<void, never, never>
}
