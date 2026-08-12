// Manifest validation and cube identity helpers -- the gates that run at mount.
//
// Split out of manifest.ts on 2026-08-12 (size cap -- the rule is "split the file, don't
// raise the number") when the generic agent gate pushed the declarative half over its
// baseline. manifest.ts keeps WHAT a cube declares; this file checks that the declaration
// cannot lie, against the real artefacts (directory names, endpoint lists).

import { AGENT_SURFACE } from "../agent-contracts.ts"
import type { CommandSpec, CubeGroup, Manifest } from "./manifest.ts"

/**
 * The agent gate, checked against the real artefact -- the same standard as the auth gate
 * in `mount.ts`: a manifest flag is a promise, the endpoint list is what will run.
 *
 * A cube declaring `agent: true` must serve all four routes of the generic surface
 * (`AGENT_SURFACE` in `agent-contracts.ts`), each under its own prefix with the method the
 * contract fixes. Missing or wrong-method routes and the cube does not mount. The reverse
 * direction needs no check: routes without the flag simply get no button -- the shell draws
 * the agent link from the catalogue, never from a guess.
 */
export const validateAgentSurface = (cube: string, m: Manifest, group: CubeGroup): void => {
  if (m.agent !== true) return
  const endpoints = Object.values(
    (group as { endpoints?: Record<string, { name: string; path: string; method: string }> }).endpoints ?? {},
  )
  const missing = Object.values(AGENT_SURFACE)
    .filter(
      ({ method, suffix }) =>
        !endpoints.some((e) => e.method === method && pathPrefix(e.path) === cube && e.path.endsWith(`/${suffix}`)),
    )
    .map(({ method, suffix }) => `${method} /${cube}/${suffix}`)
  if (missing.length > 0) {
    throw new InvalidManifestError(cube, [
      `declares agent: true but does not serve the generic agent surface -- missing: ${missing.join(", ")}. ` +
        `The catalogue would publish a button with nothing behind it, so the cube does not mount.`,
    ])
  }
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

/** Path-safe identity segments for discovery/install filesystem joins. */
export const identitySegments = (full: string): ReadonlyArray<string> => full.split("/")

/** The first segment of an HTTP path -- the segment the on/off switch matches on. */
export const pathPrefix = (path: string): string | undefined => path.split("/").filter(Boolean)[0]

/** The dash form used for route prefixes: `booktags/settings` -> `booktags-settings`. */
export const dashForm = (full: string): string => full.replace("/", "-")

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
  // `qwbe` is the kernel's own publisher name on the bus -- a cube carrying it could speak
  // with the kernel's voice (qwbe/cube.enabled) and no subscriber could tell the difference.
  if (m.name === "qwbe") {
    reasons.push(`name "qwbe" is reserved for the kernel -- it is the publisher name of kernel announcements`)
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
